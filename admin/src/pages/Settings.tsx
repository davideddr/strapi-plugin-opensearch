import * as React from 'react';
import {
  Badge,
  Box,
  Button,
  Dialog,
  Flex,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tooltip,
  Tr,
  Typography,
} from '@strapi/design-system';
import { ArrowClockwise } from '@strapi/icons';
import {
  ConfirmDialog,
  Layouts,
  Page,
  isFetchError,
  useAPIErrorHandler,
  useFetchClient,
  useNotification,
  useRBAC,
} from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { PERMISSIONS } from '../permissions';
import { PLUGIN_ID } from '../pluginId';
import type { ContentTypeStatus, LocaleStatus, PluginStatus, ReindexReport } from '../types';
import { getTranslation } from '../utils/getTranslation';

/** Status polling interval while a reindex is running or queued. */
const POLL_MS = 2000;
const ALL = '*';
const LOCALE_CELL_PADDING = { paddingLeft: 16, paddingRight: 16 };

const API = {
  status: `/${PLUGIN_ID}/status`,
  reindexAll: `/${PLUGIN_ID}/reindex`,
  reindex: (uid: string) => `/${PLUGIN_ID}/reindex/${encodeURIComponent(uid)}`,
};

type Translate = (id: string, defaultMessage: string, values?: Record<string, React.ReactNode>) => string;

const useT = (): Translate => {
  const { formatMessage } = useIntl();
  return React.useCallback(
    (id, defaultMessage, values) =>
      formatMessage({ id: getTranslation(id), defaultMessage }, values as Record<string, string>),
    [formatMessage],
  );
};

const failedItems = (report: ReindexReport) => report.locales.reduce((sum, locale) => sum + locale.failed, 0);

const Dash = () => <Typography textColor="neutral500">—</Typography>;

const ClusterBadge = ({ cluster }: { cluster: PluginStatus['cluster'] }) => {
  const t = useT();

  if (!cluster.ok) {
    return (
      <Flex gap={2} wrap="wrap">
        <Badge variant="danger">{t('cluster.down', 'Disconnected')}</Badge>
        <Typography variant="pi" textColor="danger600">
          {cluster.error}
        </Typography>
      </Flex>
    );
  }

  return (
    <Flex gap={2} wrap="wrap">
      <Badge variant="success">{t('cluster.up', 'Connected')}</Badge>
      <Typography variant="pi" textColor="neutral600">
        {t('cluster.details', '{name} · {distribution} {version}', {
          name: cluster.clusterName,
          distribution: cluster.distribution ?? 'opensearch',
          version: cluster.version,
        })}
      </Typography>
    </Flex>
  );
};

const CountCell = ({ locale }: { locale: LocaleStatus }) => {
  const t = useT();
  const { formatNumber } = useIntl();

  if (locale.count === null) {
    return locale.error ? (
      <Tooltip label={locale.error}>
        <Typography textColor="danger600">{t('table.unavailable', 'n/a')}</Typography>
      </Tooltip>
    ) : (
      <Dash />
    );
  }

  const value = formatNumber(locale.count);
  if (locale.published === null || locale.published === locale.count) {
    return <Typography>{value}</Typography>;
  }

  return (
    <Tooltip
      label={t(
        'table.mismatch',
        'Differs from Strapi: run a reindex. A configured filter can legitimately exclude entries.',
      )}
    >
      <Typography textColor="warning600" fontWeight="bold">
        {value}
      </Typography>
    </Tooltip>
  );
};

const StateBadge = ({ contentType }: { contentType: ContentTypeStatus }) => {
  const t = useT();
  if (contentType.reindexing) return <Badge variant="primary">{t('state.reindexing', 'Reindexing…')}</Badge>;
  if (contentType.queued) return <Badge variant="secondary">{t('state.queued', 'Queued')}</Badge>;
  return null;
};

const LastReindex = ({ report }: { report: ReindexReport | null }) => {
  const t = useT();
  const { formatDate, formatNumber } = useIntl();

  if (!report) return <Dash />;

  const failed = failedItems(report);
  const variant = !report.ok ? 'danger' : failed > 0 ? 'warning' : 'success';
  const label = !report.ok
    ? t('report.failed', 'Failed')
    : failed > 0
      ? t('report.partial', '{failed} failed', { failed: formatNumber(failed) })
      : t('report.ok', 'OK');
  const errors = [report.error, ...report.locales.map((locale) => locale.error)].filter(Boolean).join(' · ');

  const badge = <Badge variant={variant}>{label}</Badge>;

  return (
    <Flex direction="column" alignItems="flex-start" gap={1}>
      {errors ? <Tooltip label={errors}>{badge}</Tooltip> : badge}
      <Typography variant="pi" textColor="neutral600">
        {formatDate(report.startedAt, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
        {t('report.duration', '{seconds} s', {
          seconds: formatNumber(report.durationMs / 1000, { maximumFractionDigits: 1 }),
        })}
      </Typography>
    </Flex>
  );
};

const SettingsPage = () => {
  const t = useT();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { formatAPIError } = useAPIErrorHandler(getTranslation);
  const {
    allowedActions: { canReindex },
    isLoading: isLoadingPermissions,
  } = useRBAC(PERMISSIONS);

  const [status, setStatus] = React.useState<PluginStatus | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  /** `ALL`, a content type uid, or `null` when the confirmation is closed. */
  const [confirmTarget, setConfirmTarget] = React.useState<string | null>(null);
  /** Uids started or seen running: when they leave the status, their outcome is notified. */
  const tracked = React.useRef<Set<string>>(new Set());
  const mounted = React.useRef(true);

  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const load = React.useCallback(async () => {
    try {
      const { data } = await get<PluginStatus>(API.status);
      if (!mounted.current) return;
      setStatus(data);
      setLoadFailed(false);
    } catch (error) {
      if (!mounted.current) return;
      setLoadFailed(true);
      toggleNotification({ type: 'danger', message: formatAPIError(error as never) });
    }
  }, [get, toggleNotification, formatAPIError]);

  const busy = status ? [...status.running, ...status.queued] : [];
  const isBusy = busy.length > 0;

  // First load right away, then poll while something is running or queued: each response
  // schedules the next request. A failed first load stops here (the page shows the error).
  React.useEffect(() => {
    if (status ? !isBusy : loadFailed) return;
    const timer = setTimeout(() => void load(), status ? POLL_MS : 0);
    return () => clearTimeout(timer);
  }, [status, isBusy, loadFailed, load]);

  // Notify the outcome of the reindexes that are no longer running or queued.
  React.useEffect(() => {
    if (!status) return;
    const active = new Set([...status.running, ...status.queued]);

    for (const uid of tracked.current) {
      if (active.has(uid)) continue;
      tracked.current.delete(uid);
      const contentType = status.contentTypes.find((ct) => ct.uid === uid);
      const report = contentType?.lastReindex;
      if (!contentType || !report) continue;

      const failed = failedItems(report);
      toggleNotification({
        type: !report.ok ? 'danger' : failed > 0 ? 'warning' : 'success',
        message: !report.ok
          ? t('notification.failed', 'Reindex of {name} failed', { name: contentType.displayName })
          : failed > 0
            ? t('notification.partial', 'Reindex of {name} completed with {failed} failed documents', {
                name: contentType.displayName,
                failed,
              })
            : t('notification.done', 'Reindex of {name} completed', { name: contentType.displayName }),
      });
    }
    active.forEach((uid) => tracked.current.add(uid));
  }, [status, t, toggleNotification]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const startReindex = async (target: string) => {
    setStarting(true);
    try {
      const { data } = await post<{ started: string[] }>(target === ALL ? API.reindexAll : API.reindex(target));
      data.started.forEach((uid) => tracked.current.add(uid));
      toggleNotification({ type: 'info', message: t('notification.started', 'Reindex started') });
    } catch (error) {
      if (isFetchError(error) && error.status === 409) {
        toggleNotification({
          type: 'warning',
          message: t('notification.conflict', 'A reindex is already running or queued'),
        });
      } else {
        toggleNotification({ type: 'danger', message: formatAPIError(error as never) });
      }
    } finally {
      if (mounted.current) {
        setStarting(false);
        setConfirmTarget(null);
        await load();
      }
    }
  };

  if (isLoadingPermissions || (!status && !loadFailed)) {
    return <Page.Loading />;
  }

  if (!status) {
    return <Page.Error />;
  }

  const clusterDown = !status.cluster.ok;
  const canStart = Boolean(canReindex) && !clusterDown && !starting;
  const confirmName =
    confirmTarget && confirmTarget !== ALL
      ? (status.contentTypes.find((ct) => ct.uid === confirmTarget)?.displayName ?? confirmTarget)
      : null;
  const rowCount = status.contentTypes.reduce((sum, ct) => sum + Math.max(ct.locales.length, 1), 0);

  return (
    <Page.Main>
      <Page.Title>{t('page.title', 'OpenSearch')}</Page.Title>
      <Layouts.Header
        title={t('page.title', 'OpenSearch')}
        subtitle={t('page.subtitle', 'Indices of the published content and manual reindex')}
        primaryAction={
          <Button startIcon={<ArrowClockwise />} disabled={!canStart || isBusy} onClick={() => setConfirmTarget(ALL)}>
            {t('action.reindexAll', 'Reindex all')}
          </Button>
        }
        secondaryAction={
          <Button variant="tertiary" loading={refreshing} onClick={() => void refresh()}>
            {t('action.refresh', 'Refresh')}
          </Button>
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Box background="neutral0" hasRadius shadow="tableShadow" padding={4}>
            <Flex gap={3} wrap="wrap">
              <Typography variant="sigma" textColor="neutral600">
                {t('cluster.title', 'Connection')}
              </Typography>
              <ClusterBadge cluster={status.cluster} />
            </Flex>
          </Box>

          {status.contentTypes.length === 0 ? (
            <Page.NoData />
          ) : (
            <Table colCount={8} rowCount={rowCount + 1}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">{t('table.contentType', 'Content type')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.locale', 'Locale')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.alias', 'Alias')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.index', 'Index')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.count', 'Indexed')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.published', 'Published in Strapi')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.lastReindex', 'Last reindex')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('table.actions', 'Actions')}</Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {status.contentTypes.flatMap((contentType) => {
                  const span = Math.max(contentType.locales.length, 1);
                  const locked = contentType.reindexing || contentType.queued;
                  const head = (
                    <>
                      <Td rowSpan={span}>
                        <Flex direction="column" alignItems="flex-start" gap={1}>
                          <Typography fontWeight="bold">{contentType.displayName}</Typography>
                          <Typography variant="pi" textColor="neutral600">
                            {contentType.uid}
                          </Typography>
                          <StateBadge contentType={contentType} />
                          {contentType.error ? (
                            <Typography variant="pi" textColor="danger600">
                              {contentType.error}
                            </Typography>
                          ) : null}
                        </Flex>
                      </Td>
                    </>
                  );
                  const tail = (
                    <>
                      <Td rowSpan={span}>
                        <LastReindex report={contentType.lastReindex} />
                      </Td>
                      <Td rowSpan={span}>
                        <Button
                          variant="secondary"
                          size="S"
                          startIcon={<ArrowClockwise />}
                          disabled={!canStart || locked}
                          onClick={() => setConfirmTarget(contentType.uid)}
                        >
                          {t('action.reindex', 'Reindex')}
                        </Button>
                      </Td>
                    </>
                  );

                  if (contentType.locales.length === 0) {
                    return [
                      <Tr key={contentType.uid}>
                        {head}
                        <Td colSpan={5}>
                          <Dash />
                        </Td>
                        {tail}
                      </Tr>,
                    ];
                  }

                  return contentType.locales.map((locale, index) => (
                    <Tr key={`${contentType.uid}:${locale.locale ?? ''}`}>
                      {index === 0 ? head : null}
                      {/* With the row-spanning cell above, this is the row's first cell: the DS gives it 4px padding. */}
                      <Td style={index === 0 ? undefined : LOCALE_CELL_PADDING}>
                        {locale.locale ? <Badge>{locale.locale}</Badge> : <Dash />}
                      </Td>
                      <Td>
                        <Typography variant="pi">{locale.alias}</Typography>
                      </Td>
                      <Td>
                        {locale.indices?.length ? (
                          <Typography variant="pi">{locale.indices.join(', ')}</Typography>
                        ) : (
                          <Dash />
                        )}
                      </Td>
                      <Td>
                        <CountCell locale={locale} />
                      </Td>
                      <Td>{locale.published === null ? <Dash /> : <PublishedCount value={locale.published} />}</Td>
                      {index === 0 ? tail : null}
                    </Tr>
                  ));
                })}
              </Tbody>
            </Table>
          )}
        </Flex>
      </Layouts.Content>

      <Dialog.Root
        open={confirmTarget !== null}
        onOpenChange={(open: boolean) => (open ? null : setConfirmTarget(null))}
      >
        <ConfirmDialog
          title={t('confirm.title', 'Confirm reindex')}
          variant="default"
          icon={<ArrowClockwise />}
          onConfirm={() => (confirmTarget ? startReindex(confirmTarget) : undefined)}
        >
          {confirmName
            ? t(
                'confirm.one',
                'A new index will be built for {name} and the alias moved to it when it is ready. Searches keep working meanwhile.',
                { name: confirmName },
              )
            : t(
                'confirm.all',
                'New indices will be built for all configured content types, one at a time. Searches keep working meanwhile.',
              )}
        </ConfirmDialog>
      </Dialog.Root>
    </Page.Main>
  );
};

const PublishedCount = ({ value }: { value: number }) => {
  const { formatNumber } = useIntl();
  return <Typography>{formatNumber(value)}</Typography>;
};

const ProtectedSettingsPage = () => (
  <Page.Protect permissions={PERMISSIONS.read}>
    <SettingsPage />
  </Page.Protect>
);

export default ProtectedSettingsPage;

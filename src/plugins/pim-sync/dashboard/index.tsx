import {
    Alert,
    AlertDescription,
    api,
    Badge,
    BulkActionComponent,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DataTableBulkActionItem,
    defineDashboardExtension,
    Progress,
    Separator,
    Spinner,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    usePaginatedList,
} from '@vendure/dashboard';
import { graphql } from '@/gql';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

// ─── GraphQL documents ────────────────────────────────────────────────────────

const getSyncStatusDoc = graphql(`
    query GetPimSyncStatus {
        getPimSyncStatus {
            state
            triggeredAt
            completedAt
            productsTotal
            productsCreated
            productsUpdated
            variantsTotal
            variantsCreated
            variantsUpdated
            errors
            message
            errorDetails {
                mpn
                sku
                error
            }
            syncMode
            sinceDate
            priceStockIncluded
            pricesUpdated
            stockUpdated
        }
    }
`);

const triggerSyncDoc = graphql(`
    mutation TriggerPimSync($includePriceStock: Boolean) {
        triggerPimSync(includePriceStock: $includePriceStock) {
            state
            triggeredAt
            productsTotal
            productsCreated
            productsUpdated
            variantsTotal
            variantsCreated
            variantsUpdated
            errors
            message
            syncMode
            sinceDate
            priceStockIncluded
            pricesUpdated
            stockUpdated
        }
    }
`);

const triggerDeltaSyncDoc = graphql(`
    mutation TriggerPimDeltaSync($includePriceStock: Boolean) {
        triggerPimDeltaSync(includePriceStock: $includePriceStock) {
            state
            triggeredAt
            productsTotal
            productsCreated
            productsUpdated
            variantsTotal
            variantsCreated
            variantsUpdated
            errors
            message
            syncMode
            sinceDate
            priceStockIncluded
            pricesUpdated
            stockUpdated
        }
    }
`);

const cancelJobDoc = graphql(`
    mutation CancelJob($jobId: ID!) {
        cancelJob(jobId: $jobId) {
            id
            state
        }
    }
`);

// ─── Types ────────────────────────────────────────────────────────────────────

type SyncState = 'idle' | 'running' | 'completed' | 'failed';

const STATE_BADGE_VARIANT: Record<SyncState, 'outline' | 'warning' | 'success' | 'destructive'> = {
    idle:      'outline',
    running:   'warning',
    completed: 'success',
    failed:    'destructive',
};

const STATE_LABEL: Record<SyncState, string> = {
    idle:      'Idle',
    running:   'Running',
    completed: 'Completed',
    failed:    'Failed',
};

// ─── Bulk action: cancel selected jobs from the job-queue-list page ───────────

const CancelJobsBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const { refetchPaginatedList } = usePaginatedList();

    const hasRunningJobs = selection.some((job: { state: string }) => job.state === 'RUNNING');

    const cancelMutation = useMutation({
        mutationFn: () =>
            Promise.all(selection.map((job: { id: string }) => api.mutate(cancelJobDoc, { jobId: job.id }))),
        onSuccess: () => {
            toast.success(`Cancelled ${selection.length} job${selection.length !== 1 ? 's' : ''}`);
            table.resetRowSelection();
            refetchPaginatedList();
        },
        onError: (error: any) => {
            toast.error('Cancel failed', { description: error?.message });
        },
    });

    return (
        <DataTableBulkActionItem
            onClick={() => cancelMutation.mutate()}
            label={hasRunningJobs
                ? 'Deselect running jobs to cancel'
                : `Cancel ${selection.length} job${selection.length !== 1 ? 's' : ''}`
            }
            confirmationText={`Cancel ${selection.length} selected job${selection.length !== 1 ? 's' : ''}?`}
            icon={XCircle}
            className="text-destructive"
            disabled={hasRunningJobs}
        />
    );
};

// ─── Page component ───────────────────────────────────────────────────────────

function CatalogueSyncPage() {
    const queryClient = useQueryClient();

    // When on, the sync also writes variant price (PIM price) and stock
    // (PIM quantity → stock location ZL10) and produces a before/after audit log.
    const [includePriceStock, setIncludePriceStock] = useState(false);

    const { data, isLoading } = useQuery({
        queryKey: ['pimSyncStatus'],
        queryFn: () => api.query(getSyncStatusDoc),
        refetchInterval: (query) => {
            const state = query.state.data?.getPimSyncStatus?.state;
            return state === 'running' ? 3000 : false;
        },
    });

    const mutation = useMutation({
        mutationFn: () => api.mutate(triggerSyncDoc)({ includePriceStock }),
        onSuccess: (result) => {
            toast.success('Full catalogue sync started');
            queryClient.setQueryData(['pimSyncStatus'], {
                getPimSyncStatus: result.triggerPimSync,
            });
            queryClient.invalidateQueries({ queryKey: ['pimSyncStatus'] });
        },
        onError: (error: any) => {
            toast.error('Failed to start catalogue sync', { description: error?.message });
        },
    });

    const deltaMutation = useMutation({
        mutationFn: () => api.mutate(triggerDeltaSyncDoc)({ includePriceStock }),
        onSuccess: (result) => {
            toast.success('Delta sync started');
            queryClient.setQueryData(['pimSyncStatus'], {
                getPimSyncStatus: result.triggerPimDeltaSync,
            });
            queryClient.invalidateQueries({ queryKey: ['pimSyncStatus'] });
        },
        onError: (error: any) => {
            toast.error('Failed to start delta sync', { description: error?.message });
        },
    });

    const status = data?.getPimSyncStatus;
    const state = (status?.state ?? 'idle') as SyncState;
    const isRunning = state === 'running' || mutation.isPending || deltaMutation.isPending;
    const badgeVariant = STATE_BADGE_VARIANT[state] ?? 'outline';

    const progressPct = isRunning && status?.productsTotal
        ? Math.round(((status.productsCreated + status.productsUpdated + status.errors) / status.productsTotal) * 100)
        : undefined;

    const errorDetails = status?.errorDetails ?? [];
    const hasErrors = (status?.errors ?? 0) > 0 && errorDetails.length > 0;
    const isTerminal = state === 'completed' || state === 'failed';

    function copyErrors() {
        const lines = errorDetails.map(d =>
            d.sku
                ? `${d.mpn} / ${d.sku}: ${d.error}`
                : `${d.mpn}: ${d.error}`,
        );
        const text = [
            `Catalogue sync — ${status?.completedAt ? new Date(status.completedAt).toLocaleString() : ''}`,
            `${errorDetails.length} issue(s) found:`,
            '',
            ...lines,
        ].join('\n');
        navigator.clipboard.writeText(text).then(() => toast.success('Error list copied to clipboard'));
    }

    return (
        <div className="p-6 max-w-2xl space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Catalogue Sync</h1>
                <p className="text-muted-foreground mt-1">
                    Imports active products from AtroCore PIM into this channel.
                    Price and stock are imported only when <strong>Include price &amp; stock</strong>{' '}
                    is ticked below; otherwise they are left untouched.
                </p>
            </div>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-base font-semibold">Last Sync</CardTitle>
                    <div className="flex items-center gap-2">
                        {status?.syncMode && (
                            <Badge variant="outline" className="text-xs">
                                {status.syncMode === 'delta' ? 'Delta' : 'Full'}
                            </Badge>
                        )}
                        {isLoading
                            ? <Badge variant="outline">…</Badge>
                            : <Badge variant={badgeVariant}>{STATE_LABEL[state]}</Badge>
                        }
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {status?.triggeredAt && (
                        <div className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">Started: </span>
                            {new Date(status.triggeredAt).toLocaleString()}
                        </div>
                    )}
                    {status?.completedAt && (
                        <div className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">Finished: </span>
                            {new Date(status.completedAt).toLocaleString()}
                        </div>
                    )}
                    {status?.syncMode === 'delta' && status.sinceDate && (
                        <div className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">Since: </span>
                            {new Date(status.sinceDate).toLocaleString()}
                        </div>
                    )}

                    {isRunning && progressPct !== undefined && (
                        <div className="space-y-1">
                            <Progress value={progressPct} className="h-2" />
                            <p className="text-xs text-muted-foreground text-right">{progressPct}%</p>
                        </div>
                    )}

                    {isTerminal && status && (
                        <>
                            <Separator />
                            <div className="space-y-2 text-sm">
                                <div className="flex gap-6">
                                    <span className="text-muted-foreground w-20">Products</span>
                                    <span>
                                        <span className="font-medium">Total: </span>
                                        {status.productsTotal}
                                    </span>
                                    <span className="text-green-600 dark:text-green-400">
                                        <span className="font-medium">Created: </span>
                                        {status.productsCreated}
                                    </span>
                                    <span className="text-blue-600 dark:text-blue-400">
                                        <span className="font-medium">Updated: </span>
                                        {status.productsUpdated}
                                    </span>
                                </div>
                                <div className="flex gap-6">
                                    <span className="text-muted-foreground w-20">Variants</span>
                                    <span>
                                        <span className="font-medium">Total: </span>
                                        {status.variantsTotal}
                                    </span>
                                    <span className="text-green-600 dark:text-green-400">
                                        <span className="font-medium">Created: </span>
                                        {status.variantsCreated}
                                    </span>
                                    <span className="text-blue-600 dark:text-blue-400">
                                        <span className="font-medium">Updated: </span>
                                        {status.variantsUpdated}
                                    </span>
                                </div>
                                <div className="flex gap-6">
                                    <span className="text-muted-foreground w-20">Price/Stock</span>
                                    {status.priceStockIncluded ? (
                                        <>
                                            <span className="text-green-600 dark:text-green-400">
                                                <span className="font-medium">Included</span>
                                            </span>
                                            <span>
                                                <span className="font-medium">Prices: </span>
                                                {status.pricesUpdated ?? 0}
                                            </span>
                                            <span>
                                                <span className="font-medium">Stock: </span>
                                                {status.stockUpdated ?? 0}
                                            </span>
                                        </>
                                    ) : (
                                        <span className="text-muted-foreground">Not included</span>
                                    )}
                                </div>
                                {(status.errors ?? 0) > 0 && (
                                    <div className="flex gap-6">
                                        <span className="text-muted-foreground w-20"></span>
                                        <span className="text-destructive">
                                            <span className="font-medium">Skipped / Errors: </span>
                                            {status.errors}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {hasErrors && !isRunning && (
                        <Alert variant="destructive">
                            <AlertDescription className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="font-semibold">
                                        {errorDetails.length} item{errorDetails.length !== 1 ? 's' : ''} could not be synced
                                    </p>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs h-7 px-2"
                                        onClick={copyErrors}
                                    >
                                        Copy list
                                    </Button>
                                </div>
                                <p className="text-xs">
                                    These products were skipped to prevent data corruption.
                                    Fix the issue described below in the PIM or Vendure, then re-run the sync.
                                </p>
                                <ul className="font-mono text-xs space-y-2 max-h-64 overflow-y-auto border-t border-destructive/30 pt-2">
                                    {errorDetails.map((d, i) => (
                                        <li key={i} className="space-y-0.5">
                                            <div className="font-semibold">
                                                {d.sku
                                                    ? <>{d.mpn} <span className="opacity-60">/</span> {d.sku}</>
                                                    : d.mpn
                                                }
                                            </div>
                                            <div className="text-destructive-foreground/80 font-sans">{d.error}</div>
                                        </li>
                                    ))}
                                </ul>
                            </AlertDescription>
                        </Alert>
                    )}

                    {state === 'failed' && status?.message && !hasErrors && (
                        <Alert variant="destructive">
                            <AlertDescription>{status.message}</AlertDescription>
                        </Alert>
                    )}
                </CardContent>
            </Card>

            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer"
                    checked={includePriceStock}
                    disabled={isRunning}
                    onChange={(e) => setIncludePriceStock(e.target.checked)}
                />
                <span>
                    Include price &amp; stock{' '}
                    <span className="text-muted-foreground">
                        (writes PIM price &amp; quantity to stock location ZL10; produces a before/after audit log)
                    </span>
                </span>
            </label>

            <TooltipProvider delayDuration={300}>
                <div className="flex gap-3">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            {/* span needed — Radix tooltips don't fire on disabled buttons */}
                            <span className={isRunning ? 'cursor-not-allowed' : undefined}>
                                <Button
                                    onClick={() => mutation.mutate()}
                                    disabled={isRunning}
                                    className="gap-2"
                                >
                                    {mutation.isPending && <Spinner />}
                                    {mutation.isPending ? 'Syncing…' : 'Full Sync'}
                                </Button>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-center">
                            Fetches <strong>all active products</strong> from PIM and upserts
                            every MPN group into Vendure. Can take several minutes for large
                            catalogues — runs in the background so you can keep working.
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className={isRunning ? 'cursor-not-allowed' : undefined}>
                                <Button
                                    variant="outline"
                                    onClick={() => deltaMutation.mutate()}
                                    disabled={isRunning}
                                    className="gap-2"
                                >
                                    {deltaMutation.isPending && <Spinner />}
                                    {deltaMutation.isPending ? 'Syncing…' : 'Delta Sync'}
                                </Button>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-center">
                            Only fetches products <strong>modified since the last completed
                            sync</strong>. Fast for routine updates. Note: products deactivated
                            in PIM are not captured — run a Full Sync periodically to pick
                            those up.
                        </TooltipContent>
                    </Tooltip>
                </div>
            </TooltipProvider>
        </div>
    );
}

// ─── Extension registration ───────────────────────────────────────────────────

export default defineDashboardExtension({
    routes: [
        {
            path: '/catalogue-sync',
            component: () => <CatalogueSyncPage />,
            loader: () => ({ breadcrumb: 'Catalogue Sync' }),
            navMenuItem: {
                sectionId: 'catalog',
                id: 'catalogue-sync',
                title: 'Catalogue Sync',
            },
        },
    ],
    dataTables: [
        {
            pageId: 'job-queue-list',
            bulkActions: [
                { component: CancelJobsBulkAction, order: 100 },
            ],
        },
    ],
});

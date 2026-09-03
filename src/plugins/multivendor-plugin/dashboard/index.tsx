import {
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
    Input,
    Label,
    Textarea,
    usePaginatedList,
} from '@vendure/dashboard';
import { graphql } from '@/gql';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

// ─── GraphQL documents ────────────────────────────────────────────────────────

const onboardSellerDoc = graphql(`
    mutation OnboardSeller($input: OnboardSellerInput!) {
        onboardSeller(input: $input) {
            channel {
                id
                code
                token
            }
            temporaryPassword
        }
    }
`);

const markPayoutsPaidDoc = graphql(`
    mutation MarkPayoutsPaid($orderIds: [ID!]!) {
        markPayoutsPaid(orderIds: $orderIds) {
            id
            customFields {
                payoutStatus
            }
        }
    }
`);

// ─── Marketplace provisioning block on the native Seller detail page ──────────

interface SellerWithChannels {
    id: string;
    name: string;
    channels?: { id: string; token: string; code: string }[];
}

function VendorProvisioningBlock({ context }: { context: { entity?: unknown } }) {
    const seller = context.entity as SellerWithChannels | undefined;
    const queryClient = useQueryClient();
    const [token, setToken] = useState('');
    const [sellerEmail, setSellerEmail] = useState('');
    const [shippingPreferenceNote, setShippingPreferenceNote] = useState('');
    const [result, setResult] = useState<{ code: string; temporaryPassword: string } | null>(null);

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(onboardSellerDoc)({
                input: {
                    sellerId: seller!.id,
                    token: token || undefined,
                    sellerEmail,
                    shippingPreferenceNote: shippingPreferenceNote || undefined,
                },
            }),
        onSuccess: res => {
            const { channel, temporaryPassword } = res.onboardSeller;
            setResult({ code: channel.code, temporaryPassword });
            toast.success(`Seller Channel "${channel.code}" created`);
            // Refetch so context.entity.channels picks up the new Channel once the user
            // dismisses the one-time-password card. Partial-match invalidation — matches the
            // query key regardless of variables (see use-detail-page.ts's ['DetailPage',
            // queryName, variables] shape).
            queryClient.invalidateQueries({ queryKey: ['DetailPage', 'SellerDetail'] });
        },
        onError: (error: any) => {
            toast.error('Failed to onboard seller', { description: error?.message });
        },
    });

    if (!seller) {
        return null;
    }

    const existingChannel = seller.channels?.[0];

    if (result) {
        return (
            <Card>
                <CardHeader className="flex flex-row items-center gap-2 space-y-0">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <CardTitle className="text-base font-semibold">
                        Channel "{result.code}" created
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                        Give this temporary password to the seller now — it is shown only once
                        and cannot be retrieved again. They should log in and change it
                        immediately.
                    </p>
                    <code className="block rounded bg-muted px-3 py-2 text-sm font-mono select-all">
                        {result.temporaryPassword}
                    </code>
                </CardContent>
            </Card>
        );
    }

    if (existingChannel) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-base font-semibold">
                        Marketplace channel provisioned
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">
                        Channel token <code>{existingChannel.token}</code>.{' '}
                        <Link
                            className="underline"
                            to="/channels/$id"
                            params={{ id: existingChannel.id }}
                        >
                            View channel
                        </Link>
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base font-semibold">Provision marketplace channel</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                    Creates a Channel, channel-scoped Role and Administrator, and a StockLocation
                    for this Seller. Does <strong>not</strong> assign a ShippingMethod or
                    PaymentMethod — do that afterwards via the normal Channel settings screens.
                </p>
                <div className="space-y-1.5">
                    <Label htmlFor="mv-token">
                        Channel token <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                        id="mv-token"
                        value={token}
                        onChange={e => setToken(e.target.value)}
                        placeholder="Leave blank for a random token"
                    />
                    <p className="text-xs text-muted-foreground">
                        Set this explicitly only to match a pre-coordinated AtroPIM Channel code,
                        so pim-sync can populate this seller's catalog.
                    </p>
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="mv-seller-email">Seller email</Label>
                    <Input
                        id="mv-seller-email"
                        type="email"
                        value={sellerEmail}
                        onChange={e => setSellerEmail(e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="mv-note">
                        Shipping/payment preference note{' '}
                        <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                        id="mv-note"
                        value={shippingPreferenceNote}
                        onChange={e => setShippingPreferenceNote(e.target.value)}
                    />
                </div>
                <Button onClick={() => mutation.mutate()} disabled={!sellerEmail || mutation.isPending}>
                    {mutation.isPending ? 'Provisioning…' : 'Provision channel'}
                </Button>
            </CardContent>
        </Card>
    );
}

// ─── Payout tracking on the existing order-list page ───────────────────────────

const PayoutStatusBadge: React.FC<{ value: string | null }> = ({ value }) => {
    if (!value) {
        return null;
    }
    return <Badge variant={value === 'paid' ? 'success' : 'outline'}>{value}</Badge>;
};

const MarkPayoutPaidBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const { refetchPaginatedList } = usePaginatedList();

    const pendingSelection = selection.filter(
        (order: { customFields?: { payoutStatus?: string | null } }) =>
            order.customFields?.payoutStatus !== 'paid',
    );

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(markPayoutsPaidDoc)({ orderIds: pendingSelection.map((o: { id: string }) => o.id) }),
        onSuccess: () => {
            toast.success(`Marked ${pendingSelection.length} payout(s) as paid`);
            table.resetRowSelection();
            refetchPaginatedList();
        },
        onError: (error: any) => {
            toast.error('Failed to mark payouts paid', { description: error?.message });
        },
    });

    return (
        <DataTableBulkActionItem
            onClick={() => mutation.mutate()}
            label={`Mark ${pendingSelection.length} payout${pendingSelection.length !== 1 ? 's' : ''} paid`}
            confirmationText={`Mark ${pendingSelection.length} Seller Order payout(s) as paid?`}
            disabled={pendingSelection.length === 0}
        />
    );
};

// ─── Extension registration ───────────────────────────────────────────────────

export default defineDashboardExtension({
    pageBlocks: [
        {
            id: 'vendor-provisioning',
            title: 'Marketplace Provisioning',
            location: {
                pageId: 'seller-detail',
                column: 'main',
                position: { blockId: 'custom-fields', order: 'after' },
            },
            shouldRender: context => !!(context.entity as { id?: string } | undefined)?.id,
            requiresPermission: ['SuperAdmin'],
            component: VendorProvisioningBlock,
        },
    ],
    detailForms: [
        {
            pageId: 'seller-detail',
            extendDetailDocument: `
                query {
                    seller(id: $id) {
                        channels {
                            id
                            token
                            code
                        }
                    }
                }
            `,
        },
    ],
    dataTables: [
        {
            pageId: 'order-list',
            extendListDocument: `
                query {
                    orders {
                        items {
                            type
                            customFields {
                                payoutStatus
                            }
                        }
                    }
                }
            `,
            displayComponents: [
                { column: 'customFields.payoutStatus', component: PayoutStatusBadge },
            ],
            bulkActions: [{ component: MarkPayoutPaidBulkAction, order: 100 }],
            // Without this, the column exists (toggleable via the column-settings icon) but is
            // NOT shown by default — easy to miss on first look at the order list.
            viewOptionDefaults: {
                columnVisibility: { 'customFields.payoutStatus': true },
            },
        },
    ],
});

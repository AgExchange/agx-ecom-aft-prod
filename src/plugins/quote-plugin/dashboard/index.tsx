import { api, Button, defineDashboardExtension, DetailPageButton, ListPage } from '@vendure/dashboard';
import { graphql } from '@/gql';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Quote admin actions surfaced on the order-detail page, plus a "Quotes" list route.
 *
 * A quote's negotiation phase is NOT `order.state` (see `../config/quote-order-process.ts`
 * — a quote spends its entire life in `Draft`), so gating on `order.state` (as the previous
 * version of this file did) no longer works. Instead every quote panel/row is gated on
 * `customFields.quoteReference != null` — the one field that is set once, on request, and
 * never cleared — with `customFields.quoteStatus` driving which actions are available.
 *
 * QUOTE LIST: since `Draft` no longer distinguishes quotes from admin-authored draft
 * orders, and quotes are drawn from many different underlying `order.state` values over
 * their lifetime (Draft while negotiating, ArrangingPayment/PaymentSettled/… once
 * accepted), the built-in order list's "State" filter can no longer surface "all quotes"
 * the way the previous design's dedicated custom states could. This version therefore DOES
 * ship a "Quotes" route, backed by the plugin's own `quotes` Admin API query (pre-filtered
 * to `quoteReference IS NOT NULL`).
 *
 * NOTE: this file is built only by `build:dashboard` (Vite), which regenerates the typed
 * `@/gql` document types by introspecting the Admin API.
 *
 * TWO DASHBOARD-ONLY BUGS FIXED HERE (see `docs/quote-plugin.md` for the full writeup):
 * 1. `QuoteActions` must be registered for BOTH `pageId: 'order-detail'` AND
 *    `pageId: 'draft-order-detail'` — Vendure renders any order in `Draft` state via a
 *    DIFFERENT page/route than a non-draft order, and a quote spends its entire negotiation
 *    in `Draft` by this plugin's design. Registering only `'order-detail'` made this panel
 *    invisible for the entire negotiation phase.
 * 2. `quoteStatus`/`quoteRequestedAt`/`quoteSentAt`/`quoteRevision` are `ui: { dashboard:
 *    false }` in `../quote.plugin.ts` (deliberately — it stops Vendure's native
 *    order-custom-fields panel from crashing on save; see docs §5). A side effect is that
 *    Vendure's own auto-injected `context.entity` query no longer includes these 4 fields
 *    AT ALL — they read as `undefined` there regardless of the order's actual data. This
 *    component fetches them itself via an explicit `quoteCustomFieldsQuery` instead;
 *    hand-written GraphQL documents are unaffected by `ui.dashboard: false` (only Vendure's
 *    own auto-injection/native-form machinery is).
 */

const sendQuoteMutation = graphql(`
  mutation SendQuote($id: ID!) {
    sendQuote(id: $id) {
      id
      customFields {
        quoteStatus
        quoteSentAt
        quoteRevision
      }
    }
  }
`);

const setQuoteValidityMutation = graphql(`
  mutation SetQuoteValidity($id: ID!, $validUntil: DateTime!) {
    setQuoteValidity(id: $id, validUntil: $validUntil) {
      id
      customFields {
        quoteValidUntil
      }
    }
  }
`);

const updateQuoteNotesMutation = graphql(`
  mutation UpdateQuoteNotes($id: ID!, $notes: String!) {
    updateQuoteNotes(id: $id, notes: $notes) {
      id
      customFields {
        quoteNotes
      }
    }
  }
`);

const createQuoteMutation = graphql(`
  mutation CreateQuote($orderId: ID!) {
    createQuote(orderId: $orderId) {
      id
      customFields {
        quoteReference
        quoteStatus
      }
    }
  }
`);

const acceptQuoteAsStaffMutation = graphql(`
  mutation AcceptQuoteAsStaff($id: ID!) {
    acceptQuote(id: $id) {
      id
      state
      customFields {
        quoteStatus
      }
    }
  }
`);

// Reads `quoteStatus`/`quoteRequestedAt`/`quoteSentAt`/`quoteRevision` explicitly because
// `ui: { dashboard: false }` (see the file-level comment above) hides them from the
// auto-injected `context.entity` query — those 4 fields are always `undefined` there.
const quoteCustomFieldsQuery = graphql(`
  query QuoteCustomFields($id: ID!) {
    order(id: $id) {
      id
      customFields {
        quoteStatus
        quoteRequestedAt
        quoteSentAt
        quoteRevision
      }
    }
  }
`);

const OPEN_QUOTE_STATUSES = ['requested', 'sent'];

const QuoteActions = ({ context }: { context: any }) => {
    const order = context?.entity;
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [validUntil, setValidUntil] = useState('');
    const [notes, setNotes] = useState<string>(order?.customFields?.quoteNotes ?? '');

    const isQuote = !!order && order.customFields?.quoteReference != null;

    // `quoteStatus`/`quoteRevision` etc. are hidden from `context.entity` by `ui.dashboard:
    // false` — fetch them explicitly instead (see the file-level comment above).
    const quoteFieldsQuery = useQuery({
        queryKey: ['quote-custom-fields', order?.id],
        queryFn: () => api.query(quoteCustomFieldsQuery, { id: order.id }),
        enabled: isQuote,
    });

    const refresh = () => queryClient.invalidateQueries();

    const convert = useMutation({
        mutationFn: api.mutate(createQuoteMutation),
        onSuccess: () => {
            toast.success('Order converted to a quote');
            refresh();
        },
        onError: (e: Error) => toast.error('Failed to convert to a quote', { description: e.message }),
    });

    const send = useMutation({
        mutationFn: api.mutate(sendQuoteMutation),
        onSuccess: () => {
            toast.success('Quote sent to customer');
            refresh();
        },
        onError: (e: Error) => toast.error('Failed to send quote', { description: e.message }),
    });

    const acceptAsStaff = useMutation({
        mutationFn: api.mutate(acceptQuoteAsStaffMutation),
        onSuccess: () => {
            toast.success('Quote accepted on the customer\'s behalf');
            refresh();
        },
        onError: (e: Error) => toast.error('Failed to accept quote', { description: e.message }),
    });

    const saveValidity = useMutation({
        mutationFn: api.mutate(setQuoteValidityMutation),
        onSuccess: () => {
            toast.success('Quote validity updated');
            refresh();
        },
        onError: (e: Error) => toast.error('Failed to update validity', { description: e.message }),
    });

    const saveNotes = useMutation({
        mutationFn: api.mutate(updateQuoteNotesMutation),
        onSuccess: () => {
            toast.success('Quote notes updated');
            refresh();
        },
        onError: (e: Error) => toast.error('Failed to update notes', { description: e.message }),
    });

    if (!order) {
        return null;
    }

    // An ordinary staff-built draft order that isn't a quote yet — offer to convert it.
    if (!isQuote) {
        if (order.state !== 'Draft') {
            return null;
        }
        return (
            <Button
                type="button"
                variant="secondary"
                disabled={convert.isPending}
                onClick={() => convert.mutate({ orderId: order.id })}
            >
                Convert to Quote
            </Button>
        );
    }

    const quoteStatus: string | null = quoteFieldsQuery.data?.order?.customFields?.quoteStatus ?? null;
    const quoteRevision: number | null =
        quoteFieldsQuery.data?.order?.customFields?.quoteRevision ?? null;
    const isOpen = OPEN_QUOTE_STATUSES.includes(quoteStatus ?? '');

    return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
                {order.customFields.quoteReference} · {quoteStatus ?? 'loading…'}
                {quoteRevision ? ` · rev ${quoteRevision}` : ''}
            </span>
            {isOpen && (
                <Button
                    type="button"
                    variant="secondary"
                    disabled={send.isPending}
                    onClick={() => send.mutate({ id: order.id })}
                >
                    {quoteStatus === 'sent' ? 'Re-send quote' : 'Send quote'}
                </Button>
            )}
            {quoteStatus === 'sent' && (
                <Button
                    type="button"
                    variant="secondary"
                    disabled={acceptAsStaff.isPending}
                    onClick={() => acceptAsStaff.mutate({ id: order.id })}
                >
                    Accept on customer's behalf
                </Button>
            )}
            {isOpen && (
                <Button type="button" variant="outline" onClick={() => setEditing(v => !v)}>
                    {editing ? 'Close' : 'Edit quote'}
                </Button>
            )}
            {isOpen && editing && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        Valid until:
                        <input
                            type="date"
                            value={validUntil}
                            onChange={e => setValidUntil(e.target.value)}
                        />
                    </label>
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={!validUntil || saveValidity.isPending}
                        onClick={() =>
                            saveValidity.mutate({
                                id: order.id,
                                validUntil: new Date(validUntil).toISOString(),
                            })
                        }
                    >
                        Set validity
                    </Button>
                    <input
                        type="text"
                        placeholder="Customer-facing notes"
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        style={{ minWidth: 220 }}
                    />
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={saveNotes.isPending}
                        onClick={() => saveNotes.mutate({ id: order.id, notes })}
                    >
                        Save notes
                    </Button>
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Quotes list route
// ---------------------------------------------------------------------------

const quotesListQuery = graphql(`
  query QuotesList($options: OrderListOptions) {
    quotes(options: $options) {
      items {
        id
        code
        createdAt
        updatedAt
        state
        customer {
          id
          firstName
          lastName
        }
        customFields {
          quoteReference
          quoteStatus
          quoteValidUntil
          quoteRevision
        }
      }
      totalItems
    }
  }
`);

function QuotesListPage({ route }: { route: any }) {
    return (
        <ListPage
            pageId="quote-list"
            route={route}
            title="Quotes"
            listQuery={quotesListQuery}
            defaultVisibility={{
                code: true,
                'customFields.quoteReference': true,
                'customFields.quoteStatus': true,
                'customFields.quoteValidUntil': true,
                customer: true,
                updatedAt: true,
            }}
            customizeColumns={{
                code: {
                    header: 'Order',
                    cell: ({ row }) => (
                        <DetailPageButton
                            href={`/orders/${row.original.id}`}
                            label={row.original.code}
                        />
                    ),
                },
            }}
        />
    );
}

export default defineDashboardExtension({
    actionBarItems: [
        {
            pageId: 'order-detail',
            component: QuoteActions,
        },
        {
            // A quote spends its entire negotiation in `Draft` state, which Vendure renders
            // via this DIFFERENT pageId, not 'order-detail' — see the file-level comment.
            pageId: 'draft-order-detail',
            component: QuoteActions,
        },
    ],
    routes: [
        {
            path: '/quotes',
            component: route => <QuotesListPage route={route} />,
            navMenuItem: {
                sectionId: 'sales',
                id: 'quotes',
                title: 'Quotes',
                url: '/quotes',
            },
        },
    ],
});

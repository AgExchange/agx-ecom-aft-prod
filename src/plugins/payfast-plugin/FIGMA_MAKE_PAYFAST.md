# PayFast Payment Integration — Figma Make Implementation Guide

## Overview

This guide explains how to add PayFast checkout to a Figma Make app connected to the Vendure backend. The backend already handles everything server-side — your app only needs to:

1. Call one GraphQL mutation to get a PayFast redirect URL
2. Redirect the user to that URL
3. Handle the return from PayFast (success or cancelled)

---

## How It Works

```
User clicks "Pay with PayFast"
        ↓
App calls createPayfastPaymentIntent mutation
        ↓
Backend returns a PayFast URL
        ↓
App redirects browser to that URL
        ↓
User pays on PayFast's hosted checkout
        ↓
PayFast notifies backend (ITN) → order is settled automatically
        ↓
PayFast redirects user back to your app's callback URL
        ↓
App reads ?orderCode= from URL → shows order confirmation
   OR reads ?cancelled=1 → shows cancellation screen
```

The backend (ITN) settles the order — **your app does not need to verify or settle the payment**. Just redirect to confirmation.

---

## Backend Connection

**GraphQL API endpoint:**
```
https://agxsites.southafricanorth.cloudapp.azure.com/shop-api
```

All mutations require the customer's session token (set via `Authorization: Bearer <token>` or a session cookie — use whichever the app already uses for other checkout mutations).

---

## Step 1 — Add the Mutation

Define this GraphQL mutation in your app:

```graphql
mutation CreatePayfastPaymentIntent($redirectUrl: String!) {
  createPayfastPaymentIntent(input: { redirectUrl: $redirectUrl }) {
    __typename
    ... on PayfastPaymentIntent {
      url
    }
    ... on PayfastPaymentIntentError {
      errorCode
      message
    }
  }
}
```

**Variable — `redirectUrl`:**
The URL in your app that PayFast will redirect back to after payment. This single URL handles both success and cancellation:
- Success: PayFast appends `?orderCode=XXXXXXXX`
- Cancelled: PayFast appends `?cancelled=1`

Example value:
```
https://your-figma-make-app.com/checkout/callback
```

---

## Step 2 — Pay Button Logic

On the page where the user confirms their order and selects PayFast as the payment method, add a "Pay Now" button with this logic:

```javascript
async function handlePayFastPayment() {
  // 1. Call the mutation
  const response = await graphqlFetch({
    query: `
      mutation CreatePayfastPaymentIntent($redirectUrl: String!) {
        createPayfastPaymentIntent(input: { redirectUrl: $redirectUrl }) {
          __typename
          ... on PayfastPaymentIntent {
            url
          }
          ... on PayfastPaymentIntentError {
            errorCode
            message
          }
        }
      }
    `,
    variables: {
      redirectUrl: 'https://your-figma-make-app.com/checkout/callback'
    }
  });

  const result = response.data.createPayfastPaymentIntent;

  // 2. Handle the result
  if (result.__typename === 'PayfastPaymentIntent') {
    // Redirect the browser to PayFast hosted checkout
    window.location.href = result.url;
  } else {
    // Show error message to user
    showError(result.message);
  }
}
```

**Important:** The order must already be in `ArrangingPayment` state before calling this mutation. If your checkout flow uses `transitionOrderToState('ArrangingPayment')` before payment, ensure that is called first.

---

## Step 3 — Callback Page

Create a page at `/checkout/callback` (matching the `redirectUrl` you passed above).

This page reads URL parameters and routes the user accordingly:

```javascript
function CallbackPage() {
  const params = new URLSearchParams(window.location.search);

  const orderCode = params.get('orderCode');
  const cancelled = params.get('cancelled');

  if (orderCode) {
    // Payment successful — ITN has already settled the order server-side
    // Just redirect to order confirmation
    navigateTo(`/order-confirmation/${orderCode}`);
    return;
  }

  if (cancelled === '1') {
    // User cancelled on PayFast — show cancellation screen (see Step 4)
    showCancelledScreen();
    return;
  }

  // Still loading — show spinner
  showLoadingSpinner();
}
```

While waiting, display a loading spinner with the text **"Verifying payment..."** — the page briefly shows while the redirect happens.

---

## Step 4 — Cancellation Screen

When `?cancelled=1` is in the URL, **do not silently redirect back to checkout**. The order is still in `ArrangingPayment` state and needs to be transitioned back to `AddingItems` before the user can check out again.

Show this screen:

```
┌─────────────────────────────────────┐
│                                     │
│         ✕  (red circle icon)        │
│                                     │
│      Payment Cancelled              │
│                                     │
│  Your payment was cancelled.        │
│  Your cart has been saved.          │
│                                     │
│  ┌─────────────────────────────┐   │
│  │     Return to Checkout      │   │  ← primary button
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │     Continue Shopping       │   │  ← secondary button
│  └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

**Both buttons must first call `transitionOrderToState('AddingItems')` before navigating**, otherwise the cart will be stuck:

```javascript
async function handleReturnToCheckout() {
  setLoading(true);
  await graphqlFetch({
    query: `
      mutation TransitionOrderToState($state: String!) {
        transitionOrderToState(state: $state) {
          __typename
          ... on Order { id state }
          ... on OrderStateTransitionError { message }
        }
      }
    `,
    variables: { state: 'AddingItems' }
  });
  navigateTo('/checkout');
}

async function handleContinueShopping() {
  setLoading(true);
  await graphqlFetch({
    query: `
      mutation TransitionOrderToState($state: String!) {
        transitionOrderToState(state: $state) {
          __typename
          ... on Order { id state }
          ... on OrderStateTransitionError { message }
        }
      }
    `,
    variables: { state: 'AddingItems' }
  });
  navigateTo('/');
}
```

Disable both buttons while the transition is in progress and show a loading state.

---

## Step 5 — Order Confirmation Page

The confirmation page at `/order-confirmation/:orderCode` should query the order by code and display it.

The order will already be in `PaymentSettled` state when the user arrives here — no further action needed.

```graphql
query GetOrderByCode($code: String!) {
  orderByCode(code: $code) {
    id
    code
    state
    totalWithTax
    lines {
      productVariant { name }
      quantity
      unitPriceWithTax
      linePriceWithTax
    }
    shippingAddress {
      fullName
      streetLine1
      city
      postalCode
      country
    }
    payments {
      method
      amount
      state
    }
  }
}
```

---

## Checklist

- [ ] `redirectUrl` in the mutation points to your app's callback page
- [ ] Callback page handles both `?orderCode=` and `?cancelled=1`
- [ ] Cancellation screen transitions order back to `AddingItems` before navigating away
- [ ] Order confirmation page queries by `orderCode` from the URL
- [ ] Order is in `ArrangingPayment` state before calling the mutation

---

## What the Backend Handles (no action needed from the app)

- Signature generation and verification
- Sending the request to PayFast
- Receiving the ITN (Instant Transaction Notification) from PayFast
- Verifying payment amount
- Settling the order (`PaymentSettled` state)
- Storing payment metadata (PayFast payment ID, amount, fees)

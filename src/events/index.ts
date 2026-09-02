/**
 * Cross-cutting VendureEvent definitions.
 *
 * Events published by one plugin and consumed elsewhere (an email handler, another
 * plugin) belong here. An event that never leaves its own plugin should stay in
 * that plugin.
 */
export { ContactInput, ContactUsEvent } from './contact';

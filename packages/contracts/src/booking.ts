import { z } from "zod";
import { NotImplementedError } from "./errors.js";
import type { FareQuote } from "./quote.js";

/**
 * PHASE 2 SEAM — interface only. Nothing here executes a purchase.
 *
 * This exists so Phase 2 slots in without a schema rewrite: `booking_status` and
 * `booking_ref` already ride along on every itinerary row, and the shape a booking
 * call will need is pinned down here. Do not implement checkout, payment capture,
 * or ticket issuance against this yet.
 */

export const BookingRequestSchema = z.object({
  quote_id: z.string().min(1),
  trip_id: z.string().min(1),
  leg_index: z.number().int().min(1),
  passengers: z
    .array(
      z.object({
        given_name: z.string(),
        family_name: z.string(),
        date_of_birth: z.string().optional(),
      }),
    )
    .min(1),
  /**
   * A payment *token* from the processor, never raw card data. Phase 2 will either
   * take a Stripe token here or hand off to the operator's own checkout — the
   * repo must never see a PAN.
   */
  payment_token: z.string().optional(),
  /** Purchase is refused unless the caller confirms the policy was shown first. */
  cancellation_policy_acknowledged: z.boolean(),
});
export type BookingRequest = z.infer<typeof BookingRequestSchema>;

export interface BookingResult {
  booking_ref: string;
  booking_status: "booked";
  total_charged: FareQuote["total_price"];
  cancellation_policy: string;
  ticket_url?: string;
}

export interface BookingProvider {
  readonly name: string;
  /** Must be shown to the user *before* any purchase confirmation in Phase 2. */
  getCancellationPolicy(quoteId: string): Promise<string>;
  book(request: BookingRequest): Promise<BookingResult>;
}

export const PHASE_2_MESSAGE =
  "Booking isn't available yet — Paddy Weekend is information-gathering only for now. " +
  "Use the booking link in the table to complete the purchase on the operator's site.";

/** Stub registered by the servers so the capability is discoverable but inert. */
export const unimplementedBookingProvider: BookingProvider = {
  name: "phase-2-stub",
  async getCancellationPolicy() {
    throw new NotImplementedError(PHASE_2_MESSAGE);
  },
  async book() {
    throw new NotImplementedError(PHASE_2_MESSAGE);
  },
};

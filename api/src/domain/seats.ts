/**
 * Cognito bills per monthly active login, so the number of logins is capped (FM-08).
 * A login with several game accounts (alts) uses one seat.
 */
export const SEAT_CAP = 100;

export interface Seats {
  used: number;
  cap: number;
}

export const seatsLeft = (seats: Seats): number => Math.max(0, seats.cap - seats.used);

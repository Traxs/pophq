// Kill switch (FM-13, P1.12). The owner or the budget trip sets an SSM parameter to "on";
// the API then answers 503 until it is set back to "off".

export type ReadFlag = () => Promise<string | undefined>;

export interface PauseCheckOptions {
  /** How long a read is reused. Keeps SSM calls to one per minute per Lambda instance. */
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/**
 * Returns a cached "is the API paused?" check. Read errors keep the last known state (or
 * "not paused" before the first read): an SSM hiccup must not take the site down, and the
 * usage-plan quota caps cost even if the flag can't be read.
 */
export function createPauseCheck(read: ReadFlag, { ttlMs = 60_000, now = Date.now, onError }: PauseCheckOptions = {}) {
  let paused = false;
  let checkedAt = -Infinity;
  let inFlight: Promise<boolean> | undefined;

  const refresh = async (): Promise<boolean> => {
    try {
      paused = (await read())?.trim().toLowerCase() === "on";
    } catch (err) {
      onError?.(err);
    }
    checkedAt = now();
    return paused;
  };

  return async (): Promise<boolean> => {
    if (now() - checkedAt < ttlMs) return paused;
    inFlight ??= refresh().finally(() => (inFlight = undefined));
    return inFlight;
  };
}

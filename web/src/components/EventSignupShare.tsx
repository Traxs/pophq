import type { EventListItem } from "../api";
import { eventSignupMessage } from "../eventShare";
import { useToast } from "./Toast";

type ShareableEvent = Pick<EventListItem, "eventId" | "title" | "startsAt" | "deadlineAt" | "sessions">;

export function EventSignupShare({ event }: { event: ShareableEvent }) {
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(eventSignupMessage(event, window.location.origin));
      toast("Signup message copied");
    } catch {
      toast("Couldn't copy the signup message");
    }
  };

  return (
    <button type="button" className="btn btn-quiet btn-small" onClick={() => void copy()}>
      Copy signup message
    </button>
  );
}

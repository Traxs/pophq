import { ErrorBanner, OfflineBanner, TabBar, TopBar } from "./components/Chrome";
import { ToastProvider } from "./components/Toast";
import { Dev } from "./pages/Dev";
import { EventPage } from "./pages/EventPage";
import { Events } from "./pages/Events";
import { Home } from "./pages/Home";
import { Members } from "./pages/Members";
import { Power } from "./pages/Power";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { usePath } from "./router";
import { SessionProvider, useAuth, useSession } from "./session";

export function App() {
  const [auth, setAuth] = useAuth();

  if (auth.status === "loading") return <div className="boot" aria-busy="true" />;
  if (auth.status === "signedOut") return <SignIn />;
  return (
    <ToastProvider>
      <SessionProvider user={auth.user} onSignedOut={() => setAuth({ status: "signedOut" })}>
        <Shell />
      </SessionProvider>
    </ToastProvider>
  );
}

function Shell() {
  const path = usePath();
  const { me, error, retry } = useSession();
  return (
    <div className="app">
      <TopBar />
      <main className="content">
        <OfflineBanner />
        {error && <ErrorBanner message={error} onRetry={retry} />}
        {!me && !error ? <div className="card skeleton" style={{ height: 120 }} /> : <Page path={path} />}
      </main>
      <TabBar />
    </div>
  );
}

function Page({ path }: { path: string }) {
  const eventId = path.startsWith("/events/") ? path.slice("/events/".length) : undefined;
  if (eventId) return <EventPage eventId={eventId} />;
  switch (path) {
    case "/events":
      return <Events />;
    case "/power":
      return <Power />;
    case "/members":
      return <Members />;
    case "/settings":
      return <Settings />;
    case "/dev":
      return import.meta.env.DEV ? <Dev /> : <Home />;
    default:
      return <Home />;
  }
}

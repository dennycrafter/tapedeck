export const metadata = {
  title: "Offline",
};

// Offline navigation fallback (SPEC 8.9): the service worker serves this page
// when a document request fails because the device has no connection.
// Kept dependency-free and static so Serwist can precache its prerendered HTML.
export default function Offline() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-zinc-50 px-6 text-center font-sans dark:bg-black">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        You&rsquo;re offline
      </h1>
      <p className="max-w-sm text-base leading-7 text-zinc-600 dark:text-zinc-400">
        Tapedeck can&rsquo;t reach the network right now. Downloaded songs keep
        playing from this device.
      </p>
    </div>
  );
}

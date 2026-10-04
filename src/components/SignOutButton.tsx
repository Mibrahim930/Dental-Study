"use client";

export function SignOutButton() {
  return (
    <button
      className="btn-secondary"
      onClick={async () => {
        await fetch("/api/account/signout", { method: "POST" });
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/account");
      }}
    >
      Sign out
    </button>
  );
}

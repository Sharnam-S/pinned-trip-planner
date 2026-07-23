"use client";

/**
 * The signed-in avatar chip (top-right of the landing/dashboard nav): shows
 * who's signed in, opens a small menu with sign-out. Renders nothing while
 * the session is loading, signed out, or on no-auth deploys — callers just
 * drop it into their nav unconditionally.
 */
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/lib/useSession";

export default function AccountMenu() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  if (!user) return null;

  const initial = (user.name ?? user.email)[0]?.toUpperCase() ?? "?";

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        className="account-chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        {user.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture} alt="" className="account-avatar" referrerPolicy="no-referrer" />
        ) : (
          <span className="account-avatar account-initial">{initial}</span>
        )}
      </button>
      {open && (
        <div className="account-pop" role="menu">
          <div className="account-who">
            <div className="account-name">{user.name ?? "Signed in"}</div>
            <div className="account-email">{user.email}</div>
          </div>
          <button className="account-signout" role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { signInWithInstagram } from "@/lib/auth-client";

function Landing() {
  const router = useRouter();
  const params = useSearchParams();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api("GET", "/api/me")
      .then(() => router.replace("/automations/"))
      .catch(() => setChecking(false));
  }, [router]);

  return (
    <div className="landing">
      <div className="card">
        <div className="brand" style={{ justifyContent: "center", fontSize: 18 }}>
          <span className="brand-dot" /> Automations
        </div>
        <h1>Turn comments into conversations</h1>
        <p>Reply to comments, DM people who ask, collect emails and send links — automatically.</p>
        {params.get("error") && <p className="error-text">Sign-in failed. Please try again.</p>}
        <button className="btn ig-btn" disabled={checking} onClick={() => signInWithInstagram()}>
          Continue with Instagram
        </button>
        <p className="small">
          Requires an Instagram professional (Business or Creator) account. We request permission to read your profile,
          manage comments and manage messages.
        </p>
        <p className="small">
          <a href="/privacy/">Privacy policy</a> · <a href="/data-deletion/">Data deletion</a>
        </p>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Landing />
    </Suspense>
  );
}

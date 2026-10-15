import { createAuthClient } from "better-auth/react";

// Same origin as the API (Fastify serves both), so no baseURL is needed.
export const authClient = createAuthClient();

export const signInWithInstagram = () =>
  authClient.signIn.social({ provider: "instagram", callbackURL: "/automations/", errorCallbackURL: "/?error=1" });

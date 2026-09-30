import { createClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated Supabase user id for this request. Set by the auth preHandler - undefined when no auth is configured (tests, offline scaffold). */
    userId?: string;
  }
}

export type AuthPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Verifies the bearer token on every request against Supabase Auth and
 * attaches the real user id to request.userId. Uses supabase.auth.getUser
 * (a call to Supabase's auth server) rather than manually verifying the JWT
 * locally - avoids re-implementing signature verification / key rotation
 * for a boundary this security-critical.
 */
export function createAuthPreHandler(supabaseUrl: string, supabaseAnonKey: string): AuthPreHandler {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  return async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Missing bearer token." });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    }

    request.userId = data.user.id;
  };
}

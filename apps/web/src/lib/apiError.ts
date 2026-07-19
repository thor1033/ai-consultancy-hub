import { NextResponse } from "next/server";

export function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error.";
  return NextResponse.json({ error: message }, { status: 500 });
}

// Postgres unique-violation SQLSTATE.
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

import { NextResponse } from "next/server";
import { authenticate, authorize, type Action, type Principal } from "@ai-hub/authz";

type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

// Route guard: authenticate the bearer token, then authorize the action (and
// optional resource, e.g. `skill:<slug>`). 401 if unauthenticated, 403 if denied.
export async function guard(
  req: Request,
  action: Action,
  resource?: string,
): Promise<Gate> {
  const principal = authenticate(req.headers);
  if (!principal) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized: missing or invalid bearer token." },
        { status: 401 },
      ),
    };
  }
  if (!(await authorize(principal, action, resource))) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Forbidden: '${principal.id}' may not ${action}${
            resource ? ` on ${resource}` : ""
          }.`,
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, principal };
}

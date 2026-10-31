"use client";

import { createContext, useContext } from "react";
import { CAN_NOTHING, atLeast, type Can, type View } from "@/lib/views";

// The signed-in person's view and permissions, for client components
// (docs/views.md). Set once by the root layout from the server's reading, so
// a client component asks "how much do I show?" without a prop thread.

const ViewContext = createContext<{ view: View; can: Can }>({ view: "standard", can: CAN_NOTHING });

export function ViewProvider({ view, can, children }: { view: View; can: Can; children: React.ReactNode }) {
  return <ViewContext.Provider value={{ view, can }}>{children}</ViewContext.Provider>;
}

export function useView(): { view: View; can: Can; atLeast: (min: View) => boolean } {
  const ctx = useContext(ViewContext);
  return { ...ctx, atLeast: (min: View) => atLeast(ctx.view, min) };
}

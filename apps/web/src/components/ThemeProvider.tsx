"use client";

import { ThemeProvider as NextThemes } from "next-themes";

// Class-based theming (adds .dark / .light to <html>), persisted, no flash.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}

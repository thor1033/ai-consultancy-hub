"use client";

import { ThemeProvider as NextThemes } from "next-themes";

// Class-based theming (adds .dark / .light to <html>), persisted, no flash.
// Paper is the brand's default surface; dark is the inverse (black) one.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}

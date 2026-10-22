import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Backdrop } from "@/components/Backdrop";
import { Sidebar } from "@/components/Sidebar";
import { MobileBar } from "@/components/MobileBar";

// No web fonts: the design system's face is Helvetica Neue from the system
// install (Helvetica → Arial as fallbacks), declared once in globals.css.

export const metadata: Metadata = {
  title: "Teqneo — AI hub",
  description:
    "Ask anything your organisation has written down. Every answer shows where it came from.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <Backdrop />
          <Sidebar />
          <div className="lg:pl-[15rem]">
            <MobileBar />
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Backdrop } from "@/components/Backdrop";
import { Sidebar } from "@/components/Sidebar";
import { MobileBar } from "@/components/MobileBar";
import { ViewProvider } from "@/components/ViewProvider";
import { viewContext } from "@/lib/viewServer";

// No web fonts: the design system's face is Helvetica Neue from the system
// install (Helvetica → Arial as fallbacks), declared once in globals.css.

export const metadata: Metadata = {
  title: "Teqneo — AI hub",
  description:
    "Ask anything your organisation has written down. Every answer shows where it came from.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The person's view and permissions, read once per request and shared with
  // the page through React's cache (docs/views.md). On a public page — sign
  // in, access denied — there is nobody, and the defaults apply.
  const { view, can, waitingForAccess } = await viewContext();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <ViewProvider view={view} can={can}>
            <Backdrop />
            <Sidebar />
            <div className="lg:pl-[15rem]">
              <MobileBar />
              {waitingForAccess && (
                <div role="status" className="panel notice-warning mx-5 mt-5 p-4 text-sm lg:mx-8">
                  You are signed in, but nobody has given you access yet. Ask an admin of this hub to add you on the Admin page.
                </div>
              )}
              {children}
            </div>
          </ViewProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Backdrop } from "@/components/Backdrop";
import { Sidebar } from "@/components/Sidebar";
import { MobileBar } from "@/components/MobileBar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const sora = Sora({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Hub — Console",
  description:
    "The tailored AI hub — run your organization's Skills, Agents, and MCPs on the AI licenses you already pay for.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${sora.variable}`}
    >
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

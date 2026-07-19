import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Hub",
  description:
    "The tailored AI hub — run your organization's Skills, Agents, and MCPs on the AI licenses you already pay for.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

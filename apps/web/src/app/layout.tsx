import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='#0a0a0a'/><rect x='4' y='3' width='7' height='10' fill='#0a84ff'/></svg>",
  );

export const metadata: Metadata = {
  metadataBase: new URL("https://textsfirst.com"),
  title: "nudge — a personal agent that lives in iMessage",
  description:
    "You run your own instance. It replies, remembers, keeps skills, and texts first from a markdown schedule — over your own Photon Cloud number.",
  openGraph: {
    title: "nudge",
    description: "A personal agent that lives in iMessage.",
    url: "https://textsfirst.com",
    siteName: "nudge",
  },
  icons: { icon: favicon },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

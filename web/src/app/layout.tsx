import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
const inter = Inter({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-inter" });
export const metadata: Metadata = { title: "KlinikaFlow · Clear care, together", description: "A synthetic-data prototype for reviewed care instructions and teach-back." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en" className={inter.variable}><body>{children}</body></html>; }

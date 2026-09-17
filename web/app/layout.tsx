import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata={title:"Insuranos — Accident Claim Assistant",description:"Hands-free voice-first accident claim intake"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}

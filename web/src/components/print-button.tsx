"use client";
import { Printer } from "lucide-react";
export default function PrintButton() { return <button className="button primary" onClick={() => window.print()}><Printer size={16} /> Print / save PDF</button>; }

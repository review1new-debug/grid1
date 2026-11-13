import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// خط عربي جيد — يُحمَّل وقت التشغيل من متصفح المستخدم (لا يعتمد على البناء)
const cairoHref =
  "https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap";

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة إدارة الوسائط",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع تبديل تسلسلي تلقائي للمفاتيح ولوحة إدارة عربية",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={cairoHref} rel="stylesheet" />
      </head>
      <body className="antialiased bg-background text-foreground" style={{ fontFamily: "'Cairo', 'Segoe UI', Tahoma, system-ui, sans-serif" }}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}

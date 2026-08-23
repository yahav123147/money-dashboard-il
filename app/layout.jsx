import './globals.css';
import { Frank_Ruhl_Libre, Heebo } from 'next/font/google';

const display = Frank_Ruhl_Libre({
  subsets: ['hebrew', 'latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-display',
});

const body = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-body',
});

export const metadata = {
  title: 'חדר מצב כסף',
  description: 'דשבורד כספים חי לעסק ישראלי. מקומי בלבד.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#F7F5F0',
};

export default function RootLayout({ children }) {
  return (
    <html lang="he" dir="rtl" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}

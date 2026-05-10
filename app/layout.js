export const metadata = {
  title: 'The Bengal Reader',
  description: 'Voting awareness site for Bengal',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

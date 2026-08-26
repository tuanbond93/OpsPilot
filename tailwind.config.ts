import type { Config } from "tailwindcss";

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        brand: {
          50: "#edfffd",
          100: "#c8fffa",
          500: "#00a19a",
          600: "#00847e",
          700: "#006f6a",
          900: "#003d3a",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

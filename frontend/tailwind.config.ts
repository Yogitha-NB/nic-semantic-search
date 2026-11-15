import type { Config } from "tailwindcss";

/**
 * Design tokens
 *  paper  - very light cool background
 *  ink    - body text (deep blue-black)
 *  brand  - ultramarine: hero, focus rings, primary surfaces
 *  coral / sun / mint - supporting accents (call to action, highlights, success)
 *
 * Result cards additionally get a per-NIC-section hue computed in page.tsx.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F4F5FB",
        ink: {
          DEFAULT: "#16212B",
          soft: "#4A5568",
          faint: "#7A8599",
        },
        line: "#DADDEB",
        brand: {
          50: "#EEF0FE",
          100: "#DDE1FC",
          200: "#BAC2F8",
          600: "#3B4BDB",
          700: "#2F3DB8",
          900: "#1B2470",
        },
        coral: "#FF6B57",
        sun: "#FFC83D",
        mint: "#2DC9A8",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "system-ui", "sans-serif"],
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { transform: "scale(1)" },
          "45%": { transform: "scale(1.12)" },
          "100%": { transform: "scale(1)" },
        },
        fade: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        rise: "rise 0.5s ease-out backwards",
        pop: "pop 0.35s ease-out",
        fade: "fade 0.3s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;

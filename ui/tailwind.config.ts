import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0b10",
        stone: "#f5f1ea",
        ember: "#ff6a3d",
        tide: "#1b4d6d",
        moss: "#4d6a4a",
        haze: "#c7c1b7"
      },
      boxShadow: {
        panel: "0 20px 60px rgba(11, 11, 16, 0.18)"
      }
    }
  },
  plugins: []
};

export default config;

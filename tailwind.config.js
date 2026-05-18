/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#e6faf5',
          100: '#b3f0e0',
          200: '#80e6cc',
          300: '#4dddb7',
          400: '#2ad1af',
          500: '#2ad1af',
          600: '#22a88c',
          700: '#1a7f69',
          800: '#115546',
          900: '#092c23',
        },
        secondary: {
          50: '#e8edf1',
          100: '#c5d0da',
          200: '#9fb3c4',
          300: '#7996ad',
          400: '#5d7da3',
          500: '#2a435b',
          600: '#243a50',
          700: '#1e3144',
          800: '#182839',
          900: '#121f2e',
        },
        tertiary: {
          50: '#e7ebee',
          100: '#c2cdd5',
          200: '#9daebb',
          300: '#788fa1',
          400: '#5d7a8e',
          500: '#213649',
          600: '#1c2f40',
          700: '#172737',
          800: '#121f2e',
          900: '#0d1825',
        },
        medium: '#5d7da3',
        light: '#e4ecf4',
      },
      fontSize: {
        base: ['15px', '22px'],
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        surface: {
          50: '#f0f1f5',
          100: '#d8dbe5',
          200: '#b4b9ca',
          300: '#8d93a8',
          400: '#6b7188',
          500: '#515669',
          600: '#3d4155',
          700: '#2a2e42',
          750: '#232737',
          800: '#1a1d2e',
          850: '#151826',
          900: '#10121f',
          950: '#0a0c16',
        },
        accent: {
          DEFAULT: '#6c5ce7',
          light: '#a29bfe',
          dark: '#5541d9',
          glow: 'rgba(108, 92, 231, 0.35)',
        },
        teal: {
          DEFAULT: '#00cec9',
          light: '#81ecec',
          dark: '#00b5b0',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display',
          'Helvetica Neue', 'PingFang SC', 'sans-serif',
        ],
        mono: [
          'SF Mono', 'JetBrains Mono', 'Fira Code', 'Menlo', 'monospace',
        ],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.25rem',
      },
      boxShadow: {
        glow: '0 0 20px rgba(108, 92, 231, 0.15)',
        'glow-lg': '0 0 40px rgba(108, 92, 231, 0.2)',
        'inner-light': 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
        panel: '0 2px 16px rgba(0, 0, 0, 0.25), 0 0 1px rgba(255,255,255,0.05)',
        button: '0 2px 8px rgba(0, 0, 0, 0.3)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 0.25s ease-out',
        'fade-in-up': 'fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'shimmer': 'shimmer 2s ease-in-out infinite',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        'progress-glow': 'progressGlow 1.5s ease-in-out infinite',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { transform: 'translateY(6px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 12px rgba(108, 92, 231, 0.2)' },
          '50%': { boxShadow: '0 0 24px rgba(108, 92, 231, 0.4)' },
        },
        progressGlow: {
          '0%, 100%': { filter: 'brightness(1)' },
          '50%': { filter: 'brightness(1.3)' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
    },
  },
  plugins: [],
};

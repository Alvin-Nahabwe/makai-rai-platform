import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone', // For Docker deployment
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;

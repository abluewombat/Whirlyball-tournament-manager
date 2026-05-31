/** @type {import('next').NextConfig} */
import path from "path";

const nextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd())
};

export default nextConfig;

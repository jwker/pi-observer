"use client";

import { useEffect, useState } from "react";

import { clockTime, relativeTime } from "@/lib/format.ts";
import { useNow } from "./hooks.ts";

interface RelativeTimeProps {
  value: string | null;
  /** 挂载前（服务端渲染）显示什么；默认显示绝对时间，避免 hydration 不一致 */
  fallback?: string;
}

/**
 * 相对时间（“3 分钟前”）。
 *
 * 单独做成组件，是为了让每秒跳动的时间只重渲染这一小块：
 * 父组件（整条时间线）不会因为时钟在走而重画。
 */
export function RelativeTime({ value, fallback }: RelativeTimeProps) {
  const now = useNow(1000);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return <>{fallback ?? clockTime(value)}</>;
  return <>{relativeTime(value, now)}</>;
}

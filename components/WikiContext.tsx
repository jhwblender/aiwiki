'use client';
import { createContext, useContext } from 'react';
import type { PageListItem } from '@/lib/types';

// Page titles for rendering [[wiki links]], shared from the shell's page list.
export const PagesContext = createContext<Map<string, PageListItem>>(new Map());

export function usePages() {
  return useContext(PagesContext);
}

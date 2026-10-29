import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const toSkipTake = ({ page, pageSize }: Pagination) => ({ skip: (page - 1) * pageSize, take: pageSize });

export const paged = <T>(items: T[], total: number, { page, pageSize }: Pagination) => ({
  items,
  pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
});

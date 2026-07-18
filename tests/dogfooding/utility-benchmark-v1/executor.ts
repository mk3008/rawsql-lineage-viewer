export interface BenchmarkQueryClient {
  query(query: string | { text: string; values: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function executeReadOnlyStatement(
  client: BenchmarkQueryClient,
  text: string,
  values: unknown[],
): Promise<Array<Record<string, unknown>>> {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query({ text, values });
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

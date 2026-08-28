const fs = require('fs');
let content = fs.readFileSync('src/__tests__/yba-pilot-acceptance.test.ts', 'utf8');

const replacement = `const mockSupabase = {
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
        }),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
      }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    }),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: null, error: null })
      })
    })
  })
};`;

content = content.replace(/const mockSupabase = \{[\s\S]*?\};/, replacement);

content = content.replace(
  /onboardingState: "PRIVATE_READY" \}/g,
  'onboardingState: "PRIVATE_READY", telegramUserId: 123, username: "test", role: "EMPLOYEE", groupId: "g1", scopeMatchReason: "test" }'
);

fs.writeFileSync('src/__tests__/yba-pilot-acceptance.test.ts', content);

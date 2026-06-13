# /verify-quality

Run comprehensive quality verification on code or documentation.

## Usage
```
/verify-quality [what to verify - file, module, feature, etc.]
```

## Process

This command orchestrates quality verification:

### Phase 1: Scope Definition
Spawn @planner to:
1. Understand what to verify
2. Identify acceptance criteria
3. Plan verification strategy
4. Set quality bar

### Phase 2: Automated Checks
Spawn @coder to:
1. Run linters
2. Run type checks
3. Run test suite
4. Check code coverage

### Phase 3: Manual Review
Spawn @verifier to:
1. Review code quality
2. Check edge cases
3. Verify error handling
4. Assess security

### Phase 4: Documentation Check
Spawn @writer to:
1. Verify docs exist
2. Check accuracy
3. Ensure completeness
4. Validate examples

### Phase 5: Report
Spawn @verifier to:
1. Compile findings
2. Assign severity
3. Suggest fixes
4. Provide sign-off

## Example

```
/verify-quality src/auth/

## Verification Scope
- **Target**: Authentication module
- **Files**: 8 files in src/auth/
- **Tests**: 47 test cases

## Automated Checks
✅ TypeScript: No errors
✅ ESLint: No warnings
✅ Tests: 47/47 passing
✅ Coverage: 87% (above 80% threshold)

## Manual Review
✅ Code quality: Good
✅ Error handling: Comprehensive
✅ Security: Password hashing, token validation
⚠️ Rate limiting: Not implemented

## Documentation
✅ API docs: Complete
✅ Setup guide: Complete
⚠️ Security notes: Missing

## Verdict
PASS WITH WARNINGS

## Recommendations
1. Add rate limiting to auth endpoints
2. Add security considerations doc
3. Consider adding refresh token flow
```

## Implementation

When you invoke `/verify-quality`, I will:

1. Parse what you want to verify
2. Spawn @planner for verification strategy
3. Run automated checks via @coder
4. Perform manual review via @verifier
5. Check documentation via @writer
6. Deliver comprehensive report

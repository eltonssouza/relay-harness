---
name: deliver-vertical-feature
description: "Use to deliver end-to-end features through vertical slices: implement database schema, domain business logic, API endpoints, frontend UI components, and automated tests cohesively."
---

# Skill: deliver-vertical-feature

## When to Use
Apply this skill when implementing a user-facing feature from start to finish across all layers of the stack.

## Vertical Slice Execution Steps

1. **Define Contract & Slicing Boundary**:
   - Break feature into thin, end-to-end vertical slices that can be delivered and tested independently.
   - Define the shared contract (TypeScript types, OpenAPI schema, DTOs) between client and server.

2. **Database & Data Access Layer**:
   - Create schema migrations, indexes, and persistence entities.
   - Write repository methods with parameterized queries and transaction boundaries.

3. **Domain Business Logic & API Layer**:
   - Implement core business rules and validations decoupled from transport protocols.
   - Create API controller endpoints with input validation, authorization checks, and error handling.

4. **Frontend UI & User Interaction**:
   - Build accessible, responsive UI components matching design tokens.
   - Implement client data fetching, loading/skeleton states, empty states, and error handling.

5. **Integrated Verification**:
   - Write unit tests for domain logic and integration tests verifying the full flow from API to database.

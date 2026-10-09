---
name: design-visual-interface
description: "Use to design consistent, accessible visual interfaces: define design token systems (colors, typography, spacing, elevation), specify comprehensive component states, and enforce WCAG contrast standards."
---

# Skill: design-visual-interface

## When to Use
Apply this skill when creating UI designs, building design systems, defining CSS layout structures, or auditing screens for visual consistency and accessibility.

## Visual Interface Design Guidelines

1. **Visual Hierarchy & Layout Rhythm**:
   - Establish clear visual hierarchy using scale, font weight, contrast, and whitespace.
   - Structure layouts using flexible grids (Flexbox / CSS Grid) across mobile, tablet, and desktop breakpoints.

2. **Systematic Design Tokens**:
   - Define color tokens: Primary brand colors, Neutrals (surfaces, borders, text), and Semantic colors (Success, Warning, Error, Info).
   - Use a consistent spacing scale (4px or 8px grid) and typographic scale.

3. **Complete Component States**:
   - Specify styling for all interactive states: Default, Hover, Active, Focus (accessible ring), Disabled, Loading/Skeleton, Empty, and Error.

4. **Visual Accessibility (WCAG 2.2 AA)**:
   - Ensure text contrast ratios meet $\ge 4.5:1$ for body text and $\ge 3:1$ for large text and UI boundaries.
   - Ensure interactive touch targets measure at least $44 	imes 44	ext{px}$.
   - Never convey status through color alone; always pair color with icons or descriptive text.

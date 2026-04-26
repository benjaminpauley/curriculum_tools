// Eastern CT Four-Year Course Planner — Data Loader
// Fetches course, program, and pathway data from GitHub and assembles window.PLANNER_DATA.
//
// Source files:
//   COURSES_URL  — courses_parsed.json        (course catalog with prerequisites)
//   PROGRAMS_URL — program_requirements_*.json (versioned major/minor/concentration requirements)
//   PATHWAYS_URL — pathways.json               (recommended four-year schedules)
//
// The loader sets window.PLANNER_DATA_READY, a Promise that resolves to window.PLANNER_DATA.
// The planner app awaits this promise rather than reading window.PLANNER_DATA synchronously,
// so the data is always ready before it is used.

(function () {

  // ── Source URLs ────────────────────────────────────────────────────────────
  const COURSES_URL  = 'https://raw.githubusercontent.com/benjaminpauley/curriculum_tools/refs/heads/main/courses_parsed.json';
  const PROGRAMS_URL = 'https://raw.githubusercontent.com/benjaminpauley/curriculum_tools/refs/heads/main/program_requirements_20260329.json';
  const PATHWAYS_URL = 'https://raw.githubusercontent.com/benjaminpauley/curriculum_tools/refs/heads/main/pathways.json';

  // ── Version selection ──────────────────────────────────────────────────────
  // Pick the program version whose window covers the given catalog term (YYYYTT).
  // Falls back to the last version in the array if no exact match is found.
  // termCode = "999999" always selects the current active version.
  function selectVersion(versions, termCode) {
    if (!versions || !versions.length) return null;
    const ct = parseInt(termCode || '999999', 10);
    return (
      versions.find(v => parseInt(v.startTerm, 10) <= ct && ct <= parseInt(v.endTerm, 10)) ||
      versions[versions.length - 1]
    );
  }

  // ── Course transformation ──────────────────────────────────────────────────
  // courses_parsed.json  →  { 'SUBJ NNN': { id, title, credits, prereqs, description, attributes } }
  //
  // Prerequisite logic mapping:
  //   NONE / OTHER          → skip (no enforced prereq)
  //   COURSE (single)       → { min: 1, courses: ['SUBJ NNN'] }
  //   ONE_OF (any one of N) → { min: 1, courses: [...] }
  //   ALL_OF (all N)        → { min: N, courses: [...] }
  function transformCourses(rawArray) {
    const courses = {};
    for (const c of rawArray) {
      const id = `${c.course_subject_prefix} ${c.course_number}`;
      const prereqs = [];

      for (const clause of (c.prerequisites || [])) {
        const { logic, courses: clauseCourses } = clause;
        if (!clauseCourses?.length || logic === 'NONE' || logic === 'OTHER') continue;

        const ids = clauseCourses
          .map(cc => (typeof cc === 'string' ? cc : `${cc.subject_prefix} ${cc.course_number}`))
          .filter(Boolean);
        if (!ids.length) continue;

        prereqs.push({
          min: logic === 'ALL_OF' ? ids.length : 1,
          courses: ids,
        });
      }

      // Pre-or-corequisites are treated as prerequisites for planning purposes.
      for (const clause of (c.pre_or_corequisites || [])) {
        const { logic, courses: clauseCourses } = clause;
        if (!clauseCourses?.length || logic === 'NONE' || logic === 'OTHER') continue;

        const ids = clauseCourses
          .map(cc => (typeof cc === 'string' ? cc : `${cc.subject_prefix} ${cc.course_number}`))
          .filter(Boolean);
        if (!ids.length) continue;

        prereqs.push({
          min: logic === 'ALL_OF' ? ids.length : 1,
          courses: ids,
        });
      }

      courses[id] = {
        id,
        title: c.course_title,
        credits: c.credit_hours?.min ?? 3,
        prereqs,
        description: c.description || '',
        attributes: c.attributes || [],
      };
    }
    return courses;
  }

  // ── Requirement flattening ─────────────────────────────────────────────────
  // program_requirements requiredCourses can be nested in requirement_groups.
  // This flattens them into the typed array the app's computeReqs() expects:
  //
  //   single_class       → one specific course required
  //   multiple_classes   → need minClasses of N listed courses
  //   credits_from_list  → need N credits from listed courses
  //   group_choice       → need at least one course from each subgroup
  //
  // The `courses` array on each item is always an array of course ID strings,
  // which is what getRole() uses for membership checks.
  function flattenRequiredCourses(rawList) {
    const result = [];

    function processItem(item) {
      if (!item) return;

      if (item.type === 'requirement_group') {
        for (const child of (item.requirements || [])) processItem(child);
        return;
      }

      if (item.type === 'single_class') {
        if (item.courses?.length) {
          result.push({ type: 'single_class', courses: item.courses, label: item.label });
        }
        return;
      }

      if (item.type === 'choice' || item.type === 'select_from') {
        const minClasses = item.min_required || item.minClasses || 1;
        if (item.courses?.length) {
          result.push({
            type: 'multiple_classes',
            courses: item.courses,
            minClasses,
            label: item.label,
          });
        }
        return;
      }

      if (item.type === 'credits_from_list') {
        result.push({
          type: 'credits_from_list',
          courses: item.courses || [],
          credits: item.credits || item.min_credits || 0,
          label: item.label,
        });
        return;
      }

      if (item.type === 'group_choice') {
        result.push({
          type: 'group_choice',
          choiceGroups: item.choiceGroups || [],
          label: item.label,
        });
        return;
      }

      // Fallback: treat as single_class if it has a courses array.
      if (item.courses?.length) {
        result.push({ type: 'single_class', courses: item.courses, label: item.label });
      }
    }

    for (const item of (rawList || [])) processItem(item);
    return result;
  }

  // ── Elective group normalization ───────────────────────────────────────────
  // Ensures each group has the fields computeReqs() and getRole() need:
  //   label, creditsRequired, expandedCourses (flat array of course ID strings)
  function normalizeElectiveGroups(rawGroups) {
    return (rawGroups || []).map(eg => ({
      label: eg.label || 'Elective',
      creditsRequired: eg.creditsRequired || eg.credits_required || eg.min_credits || 0,
      expandedCourses: eg.expandedCourses || eg.courses || [],
    }));
  }

  // ── Program transformation ─────────────────────────────────────────────────
  // program_requirements_*.json  →  { majors, minors, concentrations }
  // Accepts an optional termCode to select the correct historical version;
  // defaults to current ("999999").
  function transformPrograms(rawPrograms, termCode) {
    const majors         = {};
    const minors         = {};
    const concentrations = {};

    function processSection(sourceObj, targetObj) {
      for (const [code, prog] of Object.entries(sourceObj || {})) {
        const version = selectVersion(prog.versions || [], termCode);
        if (!version) continue;

        targetObj[code] = {
          code,
          name: prog.programName,
          requiredCourses: flattenRequiredCourses(version.requiredCourses),
          electiveGroups:  normalizeElectiveGroups(version.electiveGroups),
          minimumCredits:  version.minimumCredits,
          minimumGPA:      version.minimumGPA,
          // Full version history preserved for future catalog-year UI.
          _versions: prog.versions,
        };
      }
    }

    processSection(rawPrograms.majors,        majors);
    processSection(rawPrograms.minors,         minors);
    processSection(rawPrograms.concentrations, concentrations);

    return { majors, minors, concentrations };
  }

  // ── Pathway transformation ─────────────────────────────────────────────────
  // pathways.json  →  { pathways, majorToConcs }
  //
  // pathways:     { bannerCode: { courseId: { yearMin, yearMax, sem } } }
  // majorToConcs: { majorCode: [concCode, ...] }
  //
  // Pathway key is the Banner concentration code when present (since concentrations
  // are the more specific qualifier), otherwise the Banner major code.
  function transformPathways(rawPathways) {
    const pathways     = {};
    const majorToConcs = {};

    for (const pathway of Object.values(rawPathways.pathways || {})) {
      const majorCode = pathway.banner_major_code;
      const concCode  = pathway.banner_concentration_code;

      if (!majorCode) continue;

      // Build majorToConcs index.
      if (concCode) {
        if (!majorToConcs[majorCode]) majorToConcs[majorCode] = [];
        if (!majorToConcs[majorCode].includes(concCode)) majorToConcs[majorCode].push(concCode);
      }

      const key        = concCode || majorCode;
      const timingMap  = {};

      // ELAC seminars (LAC 100, LAC 101, LAC 200, LAC 400).
      for (const seminar of (pathway.elac?.seminars || [])) {
        addTiming(timingMap, seminar.raw_course_code, seminar.year, seminar.year, seminar.semester);
      }

      // Foundational math and writing placements.
      for (const field of ['foundational_math', 'foundational_writing']) {
        const f = pathway.elac?.[field];
        if (!f) continue;
        const codes = f.course_classification?.course_codes || [f.raw_course_code];
        for (const code of codes) {
          addTiming(timingMap, code, f.year, f.year, f.semester);
        }
      }

      // Requirement section courses.
      for (const section of (pathway.requirement_sections || [])) {
        for (const course of (section.courses || [])) {
          const codes = course.course_classification?.course_codes || [course.raw_course_code];
          for (const code of codes) {
            addTiming(timingMap, code, course.year_min, course.year_max, course.semester);
          }
        }
      }

      pathways[key] = timingMap;
    }

    return { pathways, majorToConcs };
  }

  // Adds a course timing entry, normalizing the semester code to the full name the app uses.
  function addTiming(map, rawCode, yearMin, yearMax, sem) {
    const code = (rawCode || '').trim();
    if (!code) return;
    const SEM_MAP = { F: 'fall', S: 'spring', W: 'winter', U: 'summer' };
    map[code] = {
      yearMin: yearMin || 1,
      yearMax: yearMax || 4,
      sem: SEM_MAP[sem] || sem || null,
    };
  }

  // ── Public helper ──────────────────────────────────────────────────────────
  // Exposed on PLANNER_DATA so future catalog-year UI can re-derive program
  // data for any term without a new network fetch.
  function getDataForTerm(termCode, rawPrograms) {
    return transformPrograms(rawPrograms, termCode);
  }

  // ── Main fetch and assembly ────────────────────────────────────────────────
  window.PLANNER_DATA_READY = Promise.all([
    fetch(COURSES_URL).then(r  => { if (!r.ok)  throw new Error(`Courses fetch failed (${r.status})`);  return r.json(); }),
    fetch(PROGRAMS_URL).then(r => { if (!r.ok)  throw new Error(`Programs fetch failed (${r.status})`); return r.json(); }),
    fetch(PATHWAYS_URL).then(r => { if (!r.ok)  throw new Error(`Pathways fetch failed (${r.status})`); return r.json(); }),
  ]).then(([rawCourses, rawPrograms, rawPathways]) => {
    const courses = transformCourses(rawCourses);
    const { majors, minors, concentrations } = transformPrograms(rawPrograms);
    const { pathways, majorToConcs }         = transformPathways(rawPathways);

    window.PLANNER_DATA = {
      courses,
      majors,
      minors,
      concentrations,
      majorToConcs,
      pathways,
      // Utility for future catalog-year selection — re-derives program data
      // for any historical term without a new network fetch.
      getDataForTerm: (termCode) => getDataForTerm(termCode, rawPrograms),
    };

    return window.PLANNER_DATA;
  });

})();

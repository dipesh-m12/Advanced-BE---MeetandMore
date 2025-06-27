const { v4: uuidv4 } = require("uuid");

// Helper to check valid team ratios
const isValidRatio = (males, females, size) => {
  if (size === 5)
    return (
      (males === 3 && females === 2) ||
      (males === 2 && females === 3) ||
      (males === 5 && females === 0) ||
      (males === 0 && females === 5)
    );
  if (size === 4)
    return (
      (males === 2 && females === 2) ||
      (males === 1 && females === 3) ||
      (males === 4 && females === 0) ||
      (males === 0 && females === 4)
    );
  if (size === 3)
    return (
      (males === 3 && females === 0) ||
      (males === 0 && females === 3) ||
      (males === 1 && females === 2)
    );
  if (size === 6) return males >= 2 && females >= 2;
  return false;
};

// Function to form teams based on number of males and females
const formTeams = (numMales, numFemales) => {
  const teams = [];
  const unassigned = { males: numMales, females: numFemales };

  const tryFormTeam = (preferredSize) => {
    // Prioritize ratios with at least 2 females where possible
    const ratios = [
      { m: 3, f: 2 }, // Size 5
      { m: 2, f: 3 }, // Size 5
      { m: 2, f: 2 }, // Size 4
      { m: 1, f: 3 }, // Size 4
      { m: 1, f: 2 }, // Size 3
      { m: 0, f: 5 }, // Size 5, all female
      { m: 0, f: 4 }, // Size 4, all female
      { m: 0, f: 3 }, // Size 3, all female
      { m: 5, f: 0 }, // Size 5, all male
      { m: 4, f: 0 }, // Size 4, all male
      { m: 3, f: 0 }, // Size 3, all male
    ].filter(
      (r) =>
        r.m + r.f === preferredSize && isValidRatio(r.m, r.f, preferredSize)
    );

    for (const { m, f } of ratios) {
      if (m <= unassigned.males && f <= unassigned.females) {
        const teamMembers = [
          ...Array(m)
            .fill()
            .map(() => ({ gender: "Male" })),
          ...Array(f)
            .fill()
            .map(() => ({ gender: "Female" })),
        ];
        teams.push({
          _id: uuidv4(),
          members: teamMembers,
        });
        unassigned.males -= m;
        unassigned.females -= f;
        return true;
      }
    }
    return false;
  };

  // Form teams of size 5 first
  while (unassigned.males + unassigned.females >= 5) {
    if (!tryFormTeam(5)) break;
  }

  // Form teams of size 4
  while (unassigned.males + unassigned.females >= 4) {
    if (!tryFormTeam(4)) break;
  }

  // Form teams of size 3
  while (unassigned.males + unassigned.females >= 3) {
    if (!tryFormTeam(3)) break;
  }

  // Handle remaining females to balance gender ratios
  if (unassigned.females > 0 && unassigned.females <= 2) {
    for (let team of teams) {
      const femaleCount = team.members.filter(
        (m) => m.gender === "Female"
      ).length;
      if (
        team.members.length < 6 &&
        femaleCount < 3 // Allow adding females to balance ratios
      ) {
        const fCount = Math.min(unassigned.females, 6 - team.members.length);
        team.members.push(
          ...Array(fCount)
            .fill()
            .map(() => ({ gender: "Female" }))
        );
        unassigned.females -= fCount;
        if (unassigned.females === 0) break;
      }
    }
  }

  // Handle remaining males (can form all-male teams if needed)
  if (unassigned.males >= 3) {
    for (let size = 5; size >= 3; size--) {
      if (unassigned.males >= size && isValidRatio(size, 0, size)) {
        const teamMembers = Array(size)
          .fill()
          .map(() => ({ gender: "Male" }));
        teams.push({
          _id: uuidv4(),
          members: teamMembers,
        });
        unassigned.males -= size;
      }
    }
  }

  return {
    teams: teams.map((t) => ({
      id: t._id,
      members: t.members.map((m) => m.gender),
    })),
    unassigned: {
      males: unassigned.males,
      females: unassigned.females,
    },
  };
};

// Function to print teams in a viewable manner
const printTeams = (numMales, numFemales) => {
  const result = formTeams(numMales, numFemales);

  console.log("=== Team Configuration ===");
  console.log(`Input: ${numMales} Males, ${numFemales} Females\n`);

  result.teams.forEach((team, index) => {
    console.log(`Team ${index + 1} (ID: ${team.id})`);
    console.log(`  Members: ${team.members.join(", ")}`);
    console.log(`  Size: ${team.members.length}`);
    console.log(
      `  Composition: ${
        team.members.filter((m) => m === "Male").length
      } Males, ${team.members.filter((m) => m === "Female").length} Females`
    );
    console.log("");
  });

  console.log("Unassigned Participants:");
  console.log(`  Males: ${result.unassigned.males}`);
  console.log(`  Females: ${result.unassigned.females}`);
  console.log("=====================");

  return result;
};

// Example usage
printTeams(1, 2);

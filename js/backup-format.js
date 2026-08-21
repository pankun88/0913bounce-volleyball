/**
 * 현재 백업 형식으로 변환한다.
 * v1은 부문 구분이 도입되기 전 형식이다. 대회명에 여자부 표기가 있으면 여자부로,
 * 그 외에는 남자부로 옮긴다.
 */
export function normalizeBackupData(data) {
  if (!data || data.type !== "backup") {
    throw new Error("올바른 백업 파일이 아닙니다.");
  }

  if (data.version === 1) {
    if (!Array.isArray(data.groups) || !Array.isArray(data.teams) ||
        !Array.isArray(data.prelimMatches) || !Array.isArray(data.finalMatches)) {
      throw new Error("올바른 백업 파일이 아닙니다.");
    }

    const tournamentName = String(data.info?.name || "").toLowerCase();
    const division = /girl|여자|여성/.test(tournamentName) ? "women" : "men";
    const addDivision = (item) => ({
      ...item,
      data: { ...(item.data || {}), division },
    });
    const info = data.info ? { ...data.info } : data.info;
    if (info && typeof info.qualifyPerGroup === "number") {
      info.qualifyPerGroup = { [division]: info.qualifyPerGroup };
    }

    return {
      ...data,
      version: 2,
      info,
      groups: data.groups.map(addDivision),
      teams: data.teams.map(addDivision),
      prelimMatches: data.prelimMatches.map(addDivision),
      finalMatches: {
        men: division === "men" ? data.finalMatches : [],
        women: division === "women" ? data.finalMatches : [],
      },
    };
  }

  if (data.version === 2 && Array.isArray(data.groups) && Array.isArray(data.teams) &&
      Array.isArray(data.prelimMatches) && data.finalMatches &&
      Array.isArray(data.finalMatches.men) && Array.isArray(data.finalMatches.women)) {
    return data;
  }

  throw new Error("올바른 백업 파일이 아닙니다.");
}

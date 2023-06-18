import fetch from "node-fetch";

export async function updateSocialNetworksState(data) {
  if (!data.socialNetworks) {
    return undefined;
  }

  // Instagram
  if (data.socialNetworkAccounts && data.socialNetworkAccounts.instagram) {
    try {
      const result = await fetch(
        `https://www.instagram.com/${data.socialNetworkAccounts.instagram}/?__a=1`
      );
      const resultJson = await result.json();
      if (
        resultJson &&
        resultJson.graphql &&
        resultJson.graphql.user &&
        resultJson.graphql.user.edge_followed_by &&
        resultJson.graphql.user.edge_followed_by.count &&
        !isNaN(resultJson.graphql.user.edge_followed_by.count)
      ) {
        data.socialNetworks = Object.assign({}, data.socialNetworks, {
          instagram: +resultJson.graphql.user.edge_followed_by.count,
        });
        console.log(
          `>> Updated data.socialNetworks.instagram = ${+resultJson.graphql.user
            .edge_followed_by.count}`
        );
      }
    } catch (e) {
      console.warn(">> Instagram update error", e.message || e.toString());
    }
  }

  // Medium
  if (data.socialNetworkAccounts && data.socialNetworkAccounts.medium) {
    try {
      const result = await fetch(
        `https://medium.com/@${data.socialNetworkAccounts.medium}?format=json`
      );
      const resultText = await result.text();
      if (resultText) {
        const string =
          typeof resultText === "string"
            ? resultText
            : JSON.stringify(resultText);
        const match = string.match(/"usersFollowedByCount":\s?([0-9]+)/);
        if (match && match[1]) {
          data.socialNetworks = Object.assign({}, data.socialNetworks, {
            medium: +match[1],
          });
          console.log(`>> Updated data.socialNetworks.medium = ${+match[1]}`);
        }
      }
    } catch (e) {
      console.warn(">> Medium update error", e.message || e.toString());
    }
  }

  // Twitter
  if (data.socialNetworkAccounts && data.socialNetworkAccounts.twitter) {
    try {
      const result = await fetch(
        `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${data.socialNetworkAccounts.twitter}`
      );
      const resultJson = await result.json();
      if (resultJson && resultJson[0] && resultJson[0].followers_count) {
        data.socialNetworks = Object.assign({}, data.socialNetworks, {
          twitter: +resultJson[0].followers_count,
        });
        console.log(
          `>> Updated data.socialNetworks.twitter = ${+resultJson[0]
            .followers_count}`
        );
      }
    } catch (e) {
      console.warn(">> Twitter update error", e.message || e.toString());
    }
  }

  // GitHub
  if (data.socialNetworkAccounts && data.socialNetworkAccounts.github) {
    try {
      const result = await fetch(
        `https://api.github.com/users/nikitaeverywhere`
      );
      const resultJson = await result.json();
      if (resultJson && resultJson.followers) {
        data.socialNetworks = Object.assign({}, data.socialNetworks, {
          github: +resultJson.followers,
        });
        console.log(
          `>> Updated data.socialNetworks.github = ${+resultJson.followers}`
        );
      }
    } catch (e) {
      console.warn(">> GitHub update error", e.message || e.toString());
    }
  }

  return data.socialNetworks;
}

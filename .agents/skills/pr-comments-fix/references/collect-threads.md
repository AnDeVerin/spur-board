# Collect review threads

- Review threads, every page (`--paginate` follows `endCursor`):

  ```
  gh api graphql --paginate -f owner=<owner> -f repo=<repo> -F pr=<N> -f query='
    query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
      repository(owner:$owner,name:$repo){pullRequest(number:$pr){
        reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}
          nodes{id isResolved path line comments(first:100){pageInfo{hasNextPage}
            nodes{body author{login}}}}}}}}'
  ```

  Keep the threads with `isResolved: false`. A thread whose `comments.pageInfo.hasNextPage` is
  true has more replies: fetch them all the same way.

  ```
  gh api graphql --paginate -f id=<thread-id> -f query='
    query($id:ID!,$endCursor:String){node(id:$id){... on PullRequestReviewThread{
      comments(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}
        nodes{body author{login}}}}}}'
  ```
